import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openMemoryDb } from "../../src/db/db.ts";
import { buildProfile, levelFromMentions, loadProfile, removeSkill, setSkill, skillGaps } from "../../src/skills/profile.ts";
import { extractResume, ResumeError } from "../../src/profile/resume.ts";

const RESUME = `
VARUN N — Senior Software Engineer, Payments

Built payment systems in Java for seven years. Java services handle
authorization and settlement. Java and Go across the ledger platform,
with Java tooling for reconciliation.

Designed ledger services on PostgreSQL. PostgreSQL tuning and schema work.

Deployed on AWS using Docker.

Touched Kubernetes once during a migration.

SKILLS: Java, Go, PostgreSQL, AWS, Docker, Kubernetes, payments, ledgers
`;

function db() {
  const handle = openMemoryDb();
  migrate(handle.raw);
  return handle;
}

describe("levelFromMentions", () => {
  test("scales with how often a skill is described", () => {
    expect(levelFromMentions(1)).toBe("exposure");
    expect(levelFromMentions(2)).toBe("working");
    expect(levelFromMentions(5)).toBe("strong");
  });

  /** Claiming expertise on someone's behalf is not the tool's place. */
  test("never claims expert from a résumé alone", () => {
    expect(levelFromMentions(50)).not.toBe("expert");
  });
});

describe("buildProfile", () => {
  test("extracts skills from résumé text", () => {
    const handle = db();
    const result = buildProfile(handle.raw, RESUME);
    const slugs = result.skills.map((s) => s.slug);

    expect(slugs).toContain("java");
    expect(slugs).toContain("postgresql");
    expect(slugs).toContain("aws");
    expect(slugs).toContain("payments");
    expect(result.added).toBe(result.skills.length);
    handle.close();
  });

  test("rates a repeatedly-described skill above a passing mention", () => {
    const handle = db();
    const { skills } = buildProfile(handle.raw, RESUME);
    const java = skills.find((s) => s.slug === "java")!;
    const k8s = skills.find((s) => s.slug === "kubernetes")!;

    const order = ["exposure", "working", "strong", "expert"];
    expect(order.indexOf(java.level)).toBeGreaterThan(order.indexOf(k8s.level));
    handle.close();
  });

  /**
   * The undercount this guards against: the extractor scans longest-alias
   * first, so a résumé saying "payment systems" once and "payments" three
   * times matched the former and counted 1 — rating a career speciality as
   * passing exposure.
   */
  test("counts mentions across every spelling of a skill", () => {
    const handle = db();
    const text = [
      "Built payment systems for seven years.",
      "High-volume payments across card networks.",
      "Payments Infrastructure lead.",
      "Owned the payments ledger.",
    ].join("\n");
    const { skills } = buildProfile(handle.raw, text);
    const payments = skills.find((s) => s.slug === "payments")!;
    expect(payments.level).not.toBe("exposure");
    handle.close();
  });

  test("records the résumé line that proves a skill", () => {
    const handle = db();
    const { skills } = buildProfile(handle.raw, RESUME);
    const java = skills.find((s) => s.slug === "java")!;
    expect(java.evidence).toBeTruthy();
    expect(java.evidence!.toLowerCase()).toContain("java");
    handle.close();
  });

  test("is idempotent — re-extraction updates rather than duplicates", () => {
    const handle = db();
    const first = buildProfile(handle.raw, RESUME);
    const second = buildProfile(handle.raw, RESUME);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(first.skills.length);
    expect(second.skills).toHaveLength(first.skills.length);
    handle.close();
  });

  /**
   * The property that makes editing worth doing: a correction that the next
   * re-extraction silently undoes is not a correction.
   */
  test("leaves pinned corrections alone when re-extracting", () => {
    const handle = db();
    buildProfile(handle.raw, RESUME);
    setSkill(handle.raw, { slug: "kubernetes", level: "expert", years: 4 });

    const after = buildProfile(handle.raw, RESUME);
    const k8s = after.skills.find((s) => s.slug === "kubernetes")!;

    expect(k8s.level).toBe("expert");
    expect(k8s.years).toBe(4);
    expect(k8s.pinned).toBe(true);
    expect(after.kept).toBeGreaterThan(0);
    handle.close();
  });

  test("counts work history as evidence too", () => {
    const handle = db();
    const { skills } = buildProfile(handle.raw, "Backend engineer.", {
      extraText: "Led the Terraform migration across 40 services.",
    });
    expect(skills.map((s) => s.slug)).toContain("terraform");
    handle.close();
  });
});

describe("manual edits", () => {
  test("adds a skill the résumé never mentioned", () => {
    const handle = db();
    setSkill(handle.raw, { slug: "kafka", level: "working", years: 1 });
    const kafka = loadProfile(handle.raw).find((s) => s.slug === "kafka")!;
    expect(kafka.level).toBe("working");
    expect(kafka.pinned).toBe(true);
    expect(kafka.source).toBe("manual");
    handle.close();
  });

  test("removes a skill", () => {
    const handle = db();
    setSkill(handle.raw, { slug: "wordpress", level: "exposure" });
    expect(removeSkill(handle.raw, "wordpress")).toBe(true);
    expect(removeSkill(handle.raw, "wordpress")).toBe(false);
    handle.close();
  });
});

describe("skillGaps", () => {
  test("ranks demanded skills you do not hold", () => {
    const handle = db();
    buildProfile(handle.raw, "Backend engineer working in Go.");

    for (let i = 0; i < 3; i++) {
      handle.raw.run(
        `INSERT INTO jobs (id, engine, first_seen, last_seen) VALUES (?, 'x', '2026-01-01', '2026-01-01')`,
        [`job${i}`],
      );
      handle.raw.run(
        `INSERT INTO job_skills (job_id, skill, label) VALUES (?, 'kafka', 'Kafka')`,
        [`job${i}`],
      );
      // A skill already held must not appear as a gap.
      handle.raw.run(`INSERT INTO job_skills (job_id, skill, label) VALUES (?, 'go', 'Go')`, [`job${i}`]);
    }

    const gaps = skillGaps(handle.raw);
    expect(gaps[0]!.slug).toBe("kafka");
    expect(gaps[0]!.jobs).toBe(3);
    expect(gaps.map((g) => g.slug)).not.toContain("go");
    handle.close();
  });
});

describe("extractResume", () => {
  test("reads a real PDF", async () => {
    const result = await extractResume("tests/fixtures/sample-resume.pdf");
    expect(result.format).toBe("pdf");
    expect(result.words).toBeGreaterThan(30);
    expect(result.text).toContain("PostgreSQL");
  });

  test("reads plain text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobscout-cv-"));
    const path = join(dir, "cv.txt");
    await writeFile(path, RESUME, "utf8");
    const result = await extractResume(path);
    expect(result.format).toBe("text");
    expect(result.suspect).toBe(false);
  });

  test("flags a file that yielded almost nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobscout-cv-"));
    const path = join(dir, "thin.txt");
    await writeFile(path, "Varun. Engineer.", "utf8");
    const result = await extractResume(path);
    // Not an error — but the kind of result a scanned image produces.
    expect(result.suspect).toBe(true);
  });

  test("refuses an unsupported format with a usable message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobscout-cv-"));
    const path = join(dir, "cv.pages");
    await writeFile(path, "x", "utf8");
    await expect(extractResume(path)).rejects.toBeInstanceOf(ResumeError);
  });

  test("reports a missing file rather than throwing something opaque", async () => {
    await expect(extractResume("/nope/missing.pdf")).rejects.toBeInstanceOf(ResumeError);
  });
});
