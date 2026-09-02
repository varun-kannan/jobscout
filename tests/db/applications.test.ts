import { describe, expect, test } from "bun:test";
import { migrate, openMemoryDb } from "../../src/db/db.ts";
import {
  AmbiguousJobError,
  listAnswers,
  listByStatus,
  markPrepared,
  noteAnswerUsed,
  recordAnswer,
  resolveApplication,
  setStatus,
  staleApplications,
  statusCounts,
  UnknownJobError,
} from "../../src/db/applications.ts";

function db(jobs: Array<{ id: string; company: string; title?: string }> = []) {
  const handle = openMemoryDb();
  migrate(handle.raw);
  for (const job of jobs) {
    handle.raw.run(
      `INSERT INTO jobs (id, engine, company, title, apply_url, first_seen, last_seen, review_status)
       VALUES (?, 'greenhouse', ?, ?, ?, '2026-01-01', '2026-01-01', 'approved')`,
      [job.id, job.company, job.title ?? "Backend Engineer", `https://x/${job.id}`],
    );
  }
  return handle;
}

const JOBS = [
  { id: "gh-aaa111", company: "Affirm" },
  { id: "gh-bbb222", company: "Razorpay", title: "Staff Engineer" },
  { id: "gh-ccc333", company: "Razorpay Labs", title: "Data Engineer" },
];

describe("markPrepared", () => {
  test("opens an application record", () => {
    const handle = db(JOBS);
    markPrepared(handle.raw, "gh-aaa111");
    const apps = listByStatus(handle.raw, "prepared");
    expect(apps).toHaveLength(1);
    expect(apps[0]!.company).toBe("Affirm");
    expect(apps[0]!.preparedAt).toBeTruthy();
    handle.close();
  });

  /** Re-preparing must not knock an application back to the start. */
  test("does not reset a status that has moved on", () => {
    const handle = db(JOBS);
    markPrepared(handle.raw, "gh-aaa111");
    setStatus(handle.raw, "gh-aaa111", "interviewing");
    markPrepared(handle.raw, "gh-aaa111");
    expect(listByStatus(handle.raw, "interviewing")).toHaveLength(1);
    expect(listByStatus(handle.raw, "prepared")).toHaveLength(0);
    handle.close();
  });
});

describe("setStatus", () => {
  test("stamps submitted_at the first time only", async () => {
    const handle = db(JOBS);
    markPrepared(handle.raw, "gh-aaa111");

    setStatus(handle.raw, "gh-aaa111", "submitted");
    const first = handle.raw
      .query<{ submitted_at: string }, []>(`SELECT submitted_at FROM applications`)
      .get()!.submitted_at;
    expect(first).toBeTruthy();

    await Bun.sleep(5);
    setStatus(handle.raw, "gh-aaa111", "interviewing");
    const after = handle.raw
      .query<{ submitted_at: string }, []>(`SELECT submitted_at FROM applications`)
      .get()!.submitted_at;
    // The date you applied is a fact; later progress must not overwrite it.
    expect(after).toBe(first);
    handle.close();
  });

  test("counts by status", () => {
    const handle = db(JOBS);
    for (const j of JOBS) markPrepared(handle.raw, j.id);
    setStatus(handle.raw, "gh-aaa111", "submitted");
    setStatus(handle.raw, "gh-bbb222", "submitted");
    expect(statusCounts(handle.raw)).toEqual({ prepared: 1, submitted: 2 });
    handle.close();
  });
});

describe("resolveApplication", () => {
  test("finds by full id", () => {
    const handle = db(JOBS);
    markPrepared(handle.raw, "gh-aaa111");
    expect(resolveApplication(handle.raw, "gh-aaa111").company).toBe("Affirm");
    handle.close();
  });

  test("finds by id prefix", () => {
    const handle = db(JOBS);
    markPrepared(handle.raw, "gh-aaa111");
    expect(resolveApplication(handle.raw, "gh-aaa").company).toBe("Affirm");
    handle.close();
  });

  /** Nobody wants to copy `greenhouse-9e4e7a9d98f4` by hand. */
  test("finds by company name, case-insensitively", () => {
    const handle = db(JOBS);
    markPrepared(handle.raw, "gh-aaa111");
    expect(resolveApplication(handle.raw, "affirm").jobId).toBe("gh-aaa111");
    expect(resolveApplication(handle.raw, "AFFIRM").jobId).toBe("gh-aaa111");
    handle.close();
  });

  test("finds by part of the title", () => {
    const handle = db(JOBS);
    markPrepared(handle.raw, "gh-bbb222");
    expect(resolveApplication(handle.raw, "staff").jobId).toBe("gh-bbb222");
    handle.close();
  });

  /**
   * Guessing between two real applications would silently record the wrong
   * one, which is far worse than asking again.
   */
  test("refuses an ambiguous reference and lists the candidates", () => {
    const handle = db(JOBS);
    markPrepared(handle.raw, "gh-bbb222");
    markPrepared(handle.raw, "gh-ccc333");

    try {
      resolveApplication(handle.raw, "razorpay");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousJobError);
      expect((err as AmbiguousJobError).candidates).toHaveLength(2);
    }
    handle.close();
  });

  test("an exact id wins over a partial match on another row", () => {
    const handle = db([...JOBS, { id: "razorpay", company: "Other Co" }]);
    markPrepared(handle.raw, "gh-bbb222");
    markPrepared(handle.raw, "razorpay");
    expect(resolveApplication(handle.raw, "razorpay").company).toBe("Other Co");
    handle.close();
  });

  test("reports an unknown reference", () => {
    const handle = db(JOBS);
    markPrepared(handle.raw, "gh-aaa111");
    expect(() => resolveApplication(handle.raw, "nonesuch")).toThrow(UnknownJobError);
    expect(() => resolveApplication(handle.raw, "  ")).toThrow(UnknownJobError);
    handle.close();
  });
});

describe("staleApplications", () => {
  const now = new Date("2026-03-01T00:00:00Z");

  function aged(handle: ReturnType<typeof db>, jobId: string, status: string, daysAgo: number) {
    const when = new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
    handle.raw.run(
      `INSERT INTO applications (job_id, status, prepared_at, submitted_at, last_status_at)
       VALUES (?, ?, ?, ?, ?)`,
      [jobId, status, when, when, when],
    );
  }

  test("finds applications that have gone quiet", () => {
    const handle = db(JOBS);
    aged(handle, "gh-aaa111", "submitted", 30);
    aged(handle, "gh-bbb222", "submitted", 3);

    const stale = staleApplications(handle.raw, 14, now);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.jobId).toBe("gh-aaa111");
    expect(stale[0]!.daysSince).toBe(30);
    handle.close();
  });

  /** Only statuses where the ball is in their court can go stale. */
  test("ignores statuses where silence means nothing", () => {
    const handle = db(JOBS);
    aged(handle, "gh-aaa111", "prepared", 60); // never sent
    aged(handle, "gh-bbb222", "offer", 60); // concluded
    aged(handle, "gh-ccc333", "ghosted", 60); // already recorded as such
    expect(staleApplications(handle.raw, 14, now)).toHaveLength(0);
    handle.close();
  });

  /**
   * Measured from the last status change, so following up resets the clock
   * rather than leaving a row permanently stale.
   */
  test("a follow-up resets the clock", () => {
    const handle = db(JOBS);
    aged(handle, "gh-aaa111", "submitted", 40);
    expect(staleApplications(handle.raw, 14, now)).toHaveLength(1);

    setStatus(handle.raw, "gh-aaa111", "responded");
    expect(staleApplications(handle.raw, 14, now)).toHaveLength(0);
    handle.close();
  });

  test("respects the threshold", () => {
    const handle = db(JOBS);
    aged(handle, "gh-aaa111", "submitted", 20);
    expect(staleApplications(handle.raw, 14, now)).toHaveLength(1);
    expect(staleApplications(handle.raw, 30, now)).toHaveLength(0);
    handle.close();
  });
});

describe("answer bank", () => {
  test("records and lists an answer", () => {
    const handle = db();
    recordAnswer(handle.raw, "Notice period?", "1 month");
    const answers = listAnswers(handle.raw);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.answer).toBe("1 month");
    handle.close();
  });

  test("re-recording updates rather than duplicating", () => {
    const handle = db();
    recordAnswer(handle.raw, "Notice period?", "1 month");
    recordAnswer(handle.raw, "Notice period?", "2 weeks");
    const answers = listAnswers(handle.raw);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.answer).toBe("2 weeks");
    handle.close();
  });

  test("orders by how often an answer has been reused", () => {
    const handle = db();
    recordAnswer(handle.raw, "A?", "a");
    recordAnswer(handle.raw, "B?", "b");
    noteAnswerUsed(handle.raw, "B?");
    noteAnswerUsed(handle.raw, "B?");
    expect(listAnswers(handle.raw)[0]!.question).toBe("B?");
    handle.close();
  });

  test("trims surrounding whitespace", () => {
    const handle = db();
    recordAnswer(handle.raw, "  Notice period?  ", "  1 month  ");
    expect(listAnswers(handle.raw)[0]).toMatchObject({
      question: "Notice period?",
      answer: "1 month",
    });
    handle.close();
  });
});
