import { describe, expect, test } from "bun:test";
import type { ZodType } from "zod";
import { migrate, openMemoryDb } from "../../src/db/db.ts";
import { AiError, NoAiError, createAiClient, type AiClient, type AskOptions } from "../../src/ai/client.ts";
import { defaultConfig } from "../../src/config/schema.ts";
import { extractJobSkills, normaliseJobs, scoreJobs } from "../../src/ai/stages.ts";
import { scoreSchema } from "../../src/ai/schemas.ts";

/**
 * A client that returns canned answers.
 *
 * Claude Code is not installed in this environment, so the live path cannot be
 * exercised here. What these tests do cover is everything around it: schema
 * validation, persistence, failure isolation, and the score cap — which is
 * where the logic actually lives.
 */
class StubClient implements AiClient {
  calls: Array<AskOptions<unknown>> = [];

  constructor(private readonly answer: (call: AskOptions<unknown>) => unknown) {}

  async available(): Promise<boolean> {
    return true;
  }

  async describe(): Promise<string> {
    return "stub";
  }

  /** Never blocks: budget enforcement is tested separately, on the router. */
  authoriseStage(): void {}

  async ask<T>(options: AskOptions<T>): Promise<T> {
    this.calls.push(options as AskOptions<unknown>);
    const raw = this.answer(options as AskOptions<unknown>);
    if (raw instanceof Error) throw raw;
    // Validated exactly as the real client validates, so a stub cannot smuggle
    // through a shape the real one would reject.
    const parsed = (options.schema as ZodType).safeParse(raw);
    if (!parsed.success) throw new AiError("stub answer failed the schema", true);
    return parsed.data as T;
  }
}

/** The client you get with no providers configured. */
function noAiClient(): AiClient {
  const handle = openMemoryDb();
  migrate(handle.raw);
  return createAiClient({
    db: handle.raw,
    config: { ...defaultConfig(), ai: { ...defaultConfig().ai, providers: [] } },
    secrets: {},
    cwd: "/tmp",
  });
}

function db(jobs: Array<Partial<{ id: string; title: string; description: string; company: string }>> = []) {
  const handle = openMemoryDb();
  migrate(handle.raw);
  for (const [i, job] of jobs.entries()) {
    handle.raw.run(
      `INSERT INTO jobs (id, engine, company, title, description, first_seen, last_seen)
       VALUES (?, 'greenhouse', ?, ?, ?, '2026-01-01', '2026-01-01')`,
      [
        job.id ?? `job${i}`,
        job.company ?? "Acme",
        job.title ?? "Backend Engineer",
        job.description ?? "We need Go and PostgreSQL experience.",
      ],
    );
  }
  return handle;
}

describe("normaliseJobs", () => {
  const answer = {
    seniority: "senior",
    yearsRequired: 5,
    employmentType: "full-time",
    remote: "remote-restricted",
    remoteRestriction: "US only",
    salaryMin: 150000,
    salaryMax: 200000,
    salaryCurrency: "USD",
    salaryPeriod: "annual",
  };

  test("persists what the model reports", async () => {
    const handle = db([{}]);
    const summary = await normaliseJobs(handle.raw, new StubClient(() => answer));
    expect(summary.succeeded).toBe(1);

    const row = handle.raw
      .query<{ seniority: string; remote: number; remote_restriction: string; salary_min: number }, []>(
        `SELECT seniority, remote, remote_restriction, salary_min FROM jobs`,
      )
      .get()!;
    expect(row.seniority).toBe("senior");
    expect(row.remote_restriction).toBe("US only");
    expect(row.salary_min).toBe(150000);
    handle.close();
  });

  /**
   * "Remote, but US only" is still remote — the restriction is the useful
   * detail and is kept beside it rather than flattening the role to onsite.
   */
  test("treats a restricted remote role as remote", async () => {
    const handle = db([{}]);
    await normaliseJobs(handle.raw, new StubClient(() => answer));
    const row = handle.raw.query<{ remote: number }, []>(`SELECT remote FROM jobs`).get()!;
    expect(row.remote).toBe(1);
    handle.close();
  });

  test("records unknown as null rather than guessing", async () => {
    const handle = db([{}]);
    await normaliseJobs(
      handle.raw,
      new StubClient(() => ({ ...answer, remote: "unknown", remoteRestriction: null })),
    );
    const row = handle.raw.query<{ remote: number | null }, []>(`SELECT remote FROM jobs`).get()!;
    expect(row.remote).toBeNull();
    handle.close();
  });

  test("rejects an answer that fails the schema", async () => {
    const handle = db([{}]);
    const summary = await normaliseJobs(
      handle.raw,
      // seniority is an enum; "very senior" is not a member.
      new StubClient(() => ({ ...answer, seniority: "very senior" })),
    );
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(1);
    handle.close();
  });

  /** One bad posting must not lose the rest of the run. */
  test("isolates a failure to the job that caused it", async () => {
    const handle = db([{ id: "a" }, { id: "b" }, { id: "c" }]);
    let call = 0;
    const summary = await normaliseJobs(
      handle.raw,
      new StubClient(() => (++call === 2 ? new AiError("model choked") : answer)),
    );
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.errors[0]).toContain("model choked");
    handle.close();
  });

  test("stops the whole stage when no AI is configured", async () => {
    const handle = db([{}]);
    await expect(normaliseJobs(handle.raw, noAiClient())).rejects.toBeInstanceOf(NoAiError);
    handle.close();
  });
});

describe("extractJobSkills", () => {
  test("resolves what the model names to canonical slugs", async () => {
    const handle = db([{}]);
    const summary = await extractJobSkills(
      handle.raw,
      new StubClient(() => ({ required: ["Golang", "Postgres"], preferred: ["K8s"] })),
    );
    expect(summary.succeeded).toBe(1);

    const rows = handle.raw
      .query<{ skill: string; requirement: string; source: string }, []>(
        `SELECT skill, requirement, source FROM job_skills ORDER BY skill`,
      )
      .all();
    expect(rows.map((r) => r.skill)).toEqual(["go", "kubernetes", "postgresql"]);
    expect(rows.find((r) => r.skill === "kubernetes")!.requirement).toBe("preferred");
    expect(rows.every((r) => r.source === "ai")).toBe(true);
    handle.close();
  });

  test("replaces what the keyword scanner found", async () => {
    const handle = db([{}]);
    handle.raw.run(
      `INSERT INTO job_skills (job_id, skill, label, requirement, source)
       VALUES ('job0', 'wordpress', 'WordPress', 'required', 'scan')`,
    );
    await extractJobSkills(handle.raw, new StubClient(() => ({ required: ["Go"], preferred: [] })));
    const skills = handle.raw
      .query<{ skill: string }, []>(`SELECT skill FROM job_skills`)
      .all()
      .map((r) => r.skill);
    expect(skills).toEqual(["go"]);
    handle.close();
  });

  /** Re-running must not spend a call per posting every time. */
  test("skips postings it has already extracted", async () => {
    const handle = db([{}]);
    const stub = new StubClient(() => ({ required: ["Go"], preferred: [] }));
    await extractJobSkills(handle.raw, stub);
    const second = await extractJobSkills(handle.raw, stub);
    expect(second.considered).toBe(0);
    expect(stub.calls).toHaveLength(1);
    handle.close();
  });

  test("accepts a posting with genuinely no skills", async () => {
    const handle = db([{}]);
    const summary = await extractJobSkills(
      handle.raw,
      new StubClient(() => ({ required: [], preferred: [] })),
    );
    expect(summary.succeeded).toBe(1);
    handle.close();
  });
});

describe("scoreJobs", () => {
  function withMatch(score = 0.8) {
    const handle = db([{}]);
    handle.raw.run(
      `INSERT INTO matches (job_id, match_score, coverage, matched, missing, bonus, matched_at)
       VALUES ('job0', ?, 0.8, '["go"]', '["kafka"]', '["java"]', '2026-01-01')`,
      [score],
    );
    return handle;
  }

  const good = { score: 5, reason: "Direct payments overlap", concerns: [], roleTypeMatch: "same" };

  test("stores the score and its reason", async () => {
    const handle = withMatch();
    const summary = await scoreJobs(handle.raw, new StubClient(() => good), {
      threshold: 0.5,
      profileSummary: "Go, payments",
    });
    expect(summary.succeeded).toBe(1);
    const row = handle.raw
      .query<{ ai_score: number; reason: string }, []>(`SELECT ai_score, reason FROM scores`)
      .get()!;
    expect(row.ai_score).toBe(5);
    expect(row.reason).toContain("payments");
    handle.close();
  });

  /**
   * The specific failure this stage exists for. A payments engineer's skills
   * match "Account Executive, Payments" almost perfectly, and ranking a real
   * corpus put exactly those roles near the top. Skill overlap cannot see it;
   * the model can, and a different kind of work is capped whatever it scores.
   */
  test("caps a role that is a different kind of work", async () => {
    const handle = withMatch();
    await scoreJobs(
      handle.raw,
      new StubClient(() => ({ ...good, score: 5, roleTypeMatch: "different" })),
      { threshold: 0.5, profileSummary: "" },
    );
    const row = handle.raw
      .query<{ ai_score: number; concerns: string }, []>(`SELECT ai_score, concerns FROM scores`)
      .get()!;
    expect(row.ai_score).toBeLessThanOrEqual(2);
    expect(JSON.parse(row.concerns)[0]).toContain("Different kind of role");
    handle.close();
  });

  test("caps an adjacent role less severely", async () => {
    const handle = withMatch();
    await scoreJobs(
      handle.raw,
      new StubClient(() => ({ ...good, score: 5, roleTypeMatch: "adjacent" })),
      { threshold: 0.5, profileSummary: "" },
    );
    const row = handle.raw.query<{ ai_score: number }, []>(`SELECT ai_score FROM scores`).get()!;
    expect(row.ai_score).toBe(4);
    handle.close();
  });

  test("leaves a same-role score untouched", async () => {
    const handle = withMatch();
    await scoreJobs(handle.raw, new StubClient(() => good), { threshold: 0.5, profileSummary: "" });
    const row = handle.raw
      .query<{ ai_score: number; concerns: string }, []>(`SELECT ai_score, concerns FROM scores`)
      .get()!;
    expect(row.ai_score).toBe(5);
    expect(JSON.parse(row.concerns)).toHaveLength(0);
    handle.close();
  });

  /** Scoring everything would spend most calls on roles never seen. */
  test("only scores what the arithmetic already rated worth it", async () => {
    const handle = withMatch(0.2);
    const stub = new StubClient(() => good);
    const summary = await scoreJobs(handle.raw, stub, { threshold: 0.5, profileSummary: "" });
    expect(summary.considered).toBe(0);
    expect(stub.calls).toHaveLength(0);
    handle.close();
  });

  test("tells the model not to re-derive the overlap", async () => {
    const handle = withMatch();
    const stub = new StubClient(() => good);
    await scoreJobs(handle.raw, stub, { threshold: 0.5, profileSummary: "" });
    const context = stub.calls[0]!.context ?? "";
    expect(context).toContain("already counted");
    expect(context).toContain("Go");
    handle.close();
  });

  test("rejects a score outside 1-5", async () => {
    const handle = withMatch();
    const summary = await scoreJobs(handle.raw, new StubClient(() => ({ ...good, score: 9 })), {
      threshold: 0.5,
      profileSummary: "",
    });
    expect(summary.failed).toBe(1);
    handle.close();
  });
});

describe("schemas", () => {
  test("reject a score that is not an integer in range", () => {
    expect(scoreSchema.safeParse({ score: 3.5, reason: "x", concerns: [], roleTypeMatch: "same" }).success).toBe(false);
    expect(scoreSchema.safeParse({ score: 0, reason: "x", concerns: [], roleTypeMatch: "same" }).success).toBe(false);
    expect(scoreSchema.safeParse({ score: 3, reason: "x", concerns: [], roleTypeMatch: "same" }).success).toBe(true);
  });

  test("reject an unknown roleTypeMatch", () => {
    expect(
      scoreSchema.safeParse({ score: 3, reason: "x", concerns: [], roleTypeMatch: "sort of" }).success,
    ).toBe(false);
  });
});
