import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPaths, type Paths } from "../../src/config/paths.ts";
import { migrate, openMemoryDb } from "../../src/db/db.ts";
import { prepareApproved } from "../../src/pipeline/prepare.ts";
import { listByStatus } from "../../src/db/applications.ts";

const temps: string[] = [];

async function setup(): Promise<{ paths: Paths; db: ReturnType<typeof openMemoryDb> }> {
  const dir = await mkdtemp(join(tmpdir(), "jobscout-prep-"));
  temps.push(dir);
  const paths = buildPaths(dir);
  await mkdir(paths.drafts, { recursive: true });
  await mkdir(paths.outbox, { recursive: true });
  const db = openMemoryDb();
  migrate(db.raw);
  return { paths, db };
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function addJob(
  db: ReturnType<typeof openMemoryDb>,
  id: string,
  status = "approved",
  company = "Affirm",
) {
  db.raw.run(
    `INSERT INTO jobs (id, engine, company, title, apply_url, first_seen, last_seen, review_status)
     VALUES (?, 'greenhouse', ?, 'Backend Engineer', 'https://x/1', '2026-01-01', '2026-01-01', ?)`,
    [id, company, status],
  );
}

async function addDraft(paths: Paths, id: string, files: Record<string, string>) {
  const dir = join(paths.drafts, id);
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, "utf8");
  }
}

describe("prepareApproved", () => {
  test("copies drafts into the outbox with final names", async () => {
    const { paths, db } = await setup();
    addJob(db, "a");
    await addDraft(paths, "a", {
      "cover_letter.md": "Dear Affirm,",
      "answers.md": "## Why us?\n\nBecause payments.",
      "resume_notes.md": "- lead with Fiserv",
    });

    const summary = await prepareApproved(db.raw, paths);
    expect(summary.prepared).toHaveLength(1);

    const written = (await readdir(join(paths.outbox, "a"))).sort();
    expect(written).toEqual(["answers_final.md", "cover_letter_final.md", "resume_notes_final.md"]);
    db.close();
  });

  /** A draft must survive, so a bad finalise can be retried. */
  test("copies rather than moves", async () => {
    const { paths, db } = await setup();
    addJob(db, "a");
    await addDraft(paths, "a", { "cover_letter.md": "Dear Affirm," });

    await prepareApproved(db.raw, paths);
    expect(await readdir(join(paths.drafts, "a"))).toContain("cover_letter.md");
    db.close();
  });

  test("opens an application record", async () => {
    const { paths, db } = await setup();
    addJob(db, "a");
    await addDraft(paths, "a", { "cover_letter.md": "Dear Affirm," });

    await prepareApproved(db.raw, paths);
    expect(listByStatus(db.raw, "prepared")).toHaveLength(1);
    db.close();
  });

  test("only touches approved jobs", async () => {
    const { paths, db } = await setup();
    addJob(db, "a", "approved");
    addJob(db, "b", "rejected", "Other");
    addJob(db, "c", "drafted", "Third");
    for (const id of ["a", "b", "c"]) {
      await addDraft(paths, id, { "cover_letter.md": "x" });
    }

    const summary = await prepareApproved(db.raw, paths);
    expect(summary.approved).toBe(1);
    expect(summary.prepared.map((p) => p.jobId)).toEqual(["a"]);
    db.close();
  });

  /** Approved but never drafted is a real state, and must be reported. */
  test("reports an approved job with no draft instead of failing", async () => {
    const { paths, db } = await setup();
    addJob(db, "a");

    const summary = await prepareApproved(db.raw, paths);
    expect(summary.prepared).toHaveLength(0);
    expect(summary.undrafted).toHaveLength(1);
    expect(summary.undrafted[0]!.company).toBe("Affirm");
    // No application row for something with nothing to send.
    expect(listByStatus(db.raw, "prepared")).toHaveLength(0);
    db.close();
  });

  test("carries a review note across as a visible instruction", async () => {
    const { paths, db } = await setup();
    addJob(db, "a");
    await addDraft(paths, "a", { "cover_letter.md": "Dear Affirm," });
    db.raw.run(
      `INSERT INTO applications (job_id, status, last_status_at, note)
       VALUES ('a', 'prepared', '2026-01-01', 'mention the Fiserv migration')`,
    );

    await prepareApproved(db.raw, paths);
    const note = await readFile(join(paths.outbox, "a", "REVIEW_NOTE.md"), "utf8");
    expect(note).toContain("mention the Fiserv migration");
    db.close();
  });

  /** Gaps must stay visible all the way to the point of applying. */
  test("keeps MISSING.md under its own name and reports the gaps", async () => {
    const { paths, db } = await setup();
    addJob(db, "a");
    await addDraft(paths, "a", {
      "cover_letter.md": "Dear Affirm,",
      "MISSING.md": "The posting asks for things your profile does not contain:\n\n- Security clearance\n- German",
    });

    const summary = await prepareApproved(db.raw, paths);
    expect(summary.prepared[0]!.missing).toEqual(["Security clearance", "German"]);
    expect(await readdir(join(paths.outbox, "a"))).toContain("MISSING.md");
    db.close();
  });

  test("ignores non-markdown files in a draft folder", async () => {
    const { paths, db } = await setup();
    addJob(db, "a");
    await addDraft(paths, "a", { "cover_letter.md": "x", "scratch.txt": "junk" });

    await prepareApproved(db.raw, paths);
    expect(await readdir(join(paths.outbox, "a"))).toEqual(["cover_letter_final.md"]);
    db.close();
  });

  test("is idempotent", async () => {
    const { paths, db } = await setup();
    addJob(db, "a");
    await addDraft(paths, "a", { "cover_letter.md": "Dear Affirm," });

    await prepareApproved(db.raw, paths);
    const second = await prepareApproved(db.raw, paths);
    expect(second.prepared).toHaveLength(1);
    expect(listByStatus(db.raw, "prepared")).toHaveLength(1);
    db.close();
  });

  test("handles nothing approved", async () => {
    const { paths, db } = await setup();
    const summary = await prepareApproved(db.raw, paths);
    expect(summary).toEqual({ approved: 0, prepared: [], undrafted: [] });
    db.close();
  });
});
