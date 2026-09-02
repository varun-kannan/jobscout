/**
 * The application lifecycle, kept deliberately small.
 *
 * One status column and a staleness query — not a CRM. The genuinely painful
 * part of a job search is not finding roles, it is the six-week amnesia: did
 * anyone reply, when did I apply, which role was Thursday's interview for.
 * Answering that needs a column and a `WHERE` clause, not a second product.
 */

import type { Database } from "bun:sqlite";

export const APPLICATION_STATUSES = [
  "prepared",
  "submitted",
  "responded",
  "interviewing",
  "offer",
  "closed",
  "ghosted",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Statuses where the ball is in their court and silence is meaningful. */
const AWAITING_REPLY: readonly ApplicationStatus[] = ["submitted", "responded"];

export interface Application {
  jobId: string;
  company: string;
  title: string;
  applyUrl: string;
  status: ApplicationStatus;
  preparedAt: string | null;
  submittedAt: string | null;
  lastStatusAt: string;
  note: string | null;
}

interface Row {
  job_id: string;
  company: string;
  title: string;
  apply_url: string;
  status: string;
  prepared_at: string | null;
  submitted_at: string | null;
  last_status_at: string;
  note: string | null;
}

function toApplication(row: Row): Application {
  return {
    jobId: row.job_id,
    company: row.company,
    title: row.title,
    applyUrl: row.apply_url,
    status: row.status as ApplicationStatus,
    preparedAt: row.prepared_at,
    submittedAt: row.submitted_at,
    lastStatusAt: row.last_status_at,
    note: row.note,
  };
}

const SELECT = `
  SELECT a.job_id, j.company, j.title, j.apply_url, a.status,
         a.prepared_at, a.submitted_at, a.last_status_at, a.note
  FROM applications a JOIN jobs j ON j.id = a.job_id
`;

export function listByStatus(db: Database, status: ApplicationStatus): Application[] {
  return db
    .query<Row, [string]>(`${SELECT} WHERE a.status = ? ORDER BY a.last_status_at`)
    .all(status)
    .map(toApplication);
}

export function allApplications(db: Database): Application[] {
  return db.query<Row, []>(`${SELECT} ORDER BY a.last_status_at DESC`).all().map(toApplication);
}

export function statusCounts(db: Database): Record<string, number> {
  const rows = db
    .query<{ status: string; n: number }, []>(
      `SELECT status, COUNT(*) AS n FROM applications GROUP BY status`,
    )
    .all();
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** Create the application row that `prepare` produces. */
export function markPrepared(db: Database, jobId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO applications (job_id, status, prepared_at, last_status_at)
    VALUES (?, 'prepared', ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      status = CASE WHEN applications.status = 'prepared' THEN 'prepared' ELSE applications.status END,
      prepared_at = COALESCE(applications.prepared_at, excluded.prepared_at)
  `).run(jobId, now, now);
}

export class UnknownJobError extends Error {
  constructor(reference: string) {
    super(`No application matches "${reference}".`);
    this.name = "UnknownJobError";
  }
}

export class AmbiguousJobError extends Error {
  constructor(
    reference: string,
    readonly candidates: Application[],
  ) {
    super(`"${reference}" matches ${candidates.length} applications.`);
    this.name = "AmbiguousJobError";
  }
}

/**
 * Find an application from something a person would actually type.
 *
 * Full id, id prefix, or part of a company name — because nobody wants to copy
 * `greenhouse-9e4e7a9d98f4` by hand to record that they submitted something.
 */
export function resolveApplication(db: Database, reference: string): Application {
  const needle = reference.trim().toLowerCase();
  if (!needle) throw new UnknownJobError(reference);

  const all = allApplications(db);
  const exact = all.find((a) => a.jobId.toLowerCase() === needle);
  if (exact) return exact;

  const matches = all.filter(
    (a) =>
      a.jobId.toLowerCase().startsWith(needle) ||
      a.company.toLowerCase().includes(needle) ||
      a.title.toLowerCase().includes(needle),
  );

  if (matches.length === 0) throw new UnknownJobError(reference);
  // Guessing between two real applications would silently record the wrong one.
  if (matches.length > 1) throw new AmbiguousJobError(reference, matches);
  return matches[0]!;
}

export function setStatus(db: Database, jobId: string, status: ApplicationStatus): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE applications
    SET status = ?,
        last_status_at = ?,
        submitted_at = CASE WHEN ? = 'submitted' AND submitted_at IS NULL THEN ? ELSE submitted_at END
    WHERE job_id = ?
  `).run(status, now, status, now, jobId);
}

export interface StaleApplication extends Application {
  daysSince: number;
}

/**
 * Applications that have gone quiet.
 *
 * Measured from the last status change rather than the submission date, so
 * following up resets the clock instead of leaving the row permanently stale.
 */
export function staleApplications(
  db: Database,
  afterDays = 14,
  now: Date = new Date(),
): StaleApplication[] {
  const placeholders = AWAITING_REPLY.map(() => "?").join(",");
  return db
    .query<Row, string[]>(`${SELECT} WHERE a.status IN (${placeholders}) ORDER BY a.last_status_at`)
    .all(...AWAITING_REPLY)
    .map(toApplication)
    .map((a) => ({
      ...a,
      daysSince: Math.floor((now.getTime() - Date.parse(a.lastStatusAt)) / 86_400_000),
    }))
    .filter((a) => Number.isFinite(a.daysSince) && a.daysSince >= afterDays);
}

/* ── answer bank ──────────────────────────────────────────────────── */

export function recordAnswer(db: Database, question: string, answer: string): void {
  db.prepare(`
    INSERT INTO answers (question, answer, confirmed_at, times_used)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(question) DO UPDATE SET answer = excluded.answer, confirmed_at = excluded.confirmed_at
  `).run(question.trim(), answer.trim(), new Date().toISOString());
}

export function listAnswers(db: Database): Array<{ question: string; answer: string; timesUsed: number }> {
  return db
    .query<{ question: string; answer: string; times_used: number }, []>(
      `SELECT question, answer, times_used FROM answers ORDER BY times_used DESC, question`,
    )
    .all()
    .map((r) => ({ question: r.question, answer: r.answer, timesUsed: r.times_used }));
}

export function noteAnswerUsed(db: Database, question: string): void {
  db.prepare(`UPDATE answers SET times_used = times_used + 1 WHERE question = ?`).run(question);
}
