/**
 * The application tracker.
 *
 * `applications` holds one row per job you have engaged with. A row appears the
 * moment you open a posting — that is what `viewed` means — so the tracker
 * answers "what have I actually looked at", not only "what did I submit".
 *
 * Every transition is recorded with its time, and `submitted_at` is stamped the
 * first time a row reaches `submitted` and never moved again: the date you
 * applied is a fact about the past, and re-picking a status later must not
 * rewrite it.
 */

import type { Database } from "bun:sqlite";
import {
  APPLICATION_STATUSES,
  type ApplicationStatus,
} from "../db/applications.ts";

export interface TrackedApplication {
  jobId: string;
  company: string;
  title: string;
  location: string;
  applyUrl: string;
  status: ApplicationStatus;
  preparedAt: string | null;
  submittedAt: string | null;
  lastStatusAt: string;
  note: string | null;
  aiScore: number | null;
  /** Days since the last movement — the number that makes silence visible. */
  daysSince: number;
  /** Waiting on them, and it has been a while. */
  stale: boolean;
}

/** Statuses where the ball is in their court, so silence means something. */
const AWAITING: readonly ApplicationStatus[] = ["submitted", "responded", "interviewing"];

export function isTrackerStatus(value: unknown): value is ApplicationStatus {
  return typeof value === "string" && (APPLICATION_STATUSES as readonly string[]).includes(value);
}

interface Row {
  job_id: string; company: string; title: string; location: string | null;
  apply_url: string | null; status: string; prepared_at: string | null;
  submitted_at: string | null; last_status_at: string; note: string | null;
  ai_score: number | null;
}

const SELECT = `
  SELECT a.job_id, j.company, j.title, j.location, j.apply_url,
         a.status, a.prepared_at, a.submitted_at, a.last_status_at, a.note,
         s.ai_score
  FROM applications a
  JOIN jobs j ON j.id = a.job_id
  LEFT JOIN scores s ON s.job_id = a.job_id`;

function toTracked(row: Row, now: Date, staleAfterDays: number): TrackedApplication {
  const last = Date.parse(row.last_status_at);
  const days = Number.isFinite(last)
    ? Math.floor((now.getTime() - last) / 86_400_000)
    : 0;
  return {
    jobId: row.job_id,
    company: row.company,
    title: row.title,
    location: row.location ?? "",
    applyUrl: row.apply_url ?? "",
    status: row.status as ApplicationStatus,
    preparedAt: row.prepared_at,
    submittedAt: row.submitted_at,
    lastStatusAt: row.last_status_at,
    note: row.note,
    aiScore: row.ai_score,
    daysSince: days,
    stale: AWAITING.includes(row.status as ApplicationStatus) && days >= staleAfterDays,
  };
}

export function listTracked(
  db: Database,
  options: { status?: string; staleAfterDays?: number; now?: Date } = {},
): TrackedApplication[] {
  const now = options.now ?? new Date();
  const staleAfter = options.staleAfterDays ?? 14;
  const rows = isTrackerStatus(options.status)
    ? db.query<Row, [string]>(`${SELECT} WHERE a.status = ? ORDER BY a.last_status_at DESC`)
        .all(options.status)
    : db.query<Row, []>(`${SELECT} ORDER BY a.last_status_at DESC`).all();
  return rows.map((r) => toTracked(r, now, staleAfter));
}

/** How many sit at each status, including the ones at zero. */
export function trackerCounts(db: Database): Record<ApplicationStatus, number> {
  const counts = Object.fromEntries(
    APPLICATION_STATUSES.map((s) => [s, 0]),
  ) as Record<ApplicationStatus, number>;
  for (const row of db
    .query<{ status: string; n: number }, []>(
      `SELECT status, COUNT(*) AS n FROM applications GROUP BY status`,
    )
    .all()) {
    if (isTrackerStatus(row.status)) counts[row.status] = row.n;
  }
  return counts;
}

/**
 * Record that a posting was opened.
 *
 * Only ever creates a row. Something already tracked has moved past `viewed`,
 * and reading it again must not drag it backwards — opening a posting you have
 * already applied to should not undo the application.
 */
export function markViewed(db: Database, jobId: string, now: Date = new Date()): boolean {
  const existing = db
    .query<{ job_id: string }, [string]>(`SELECT job_id FROM applications WHERE job_id = ?`)
    .get(jobId);
  if (existing) return false;
  db.query(
    `INSERT INTO applications (job_id, status, last_status_at) VALUES (?, 'viewed', ?)`,
  ).run(jobId, now.toISOString());
  return true;
}

export interface UpdateResult {
  ok: boolean;
  error?: string;
}

/**
 * Set a status, a note, or both.
 *
 * Creates the row if the job was never opened — updating a status is a stronger
 * statement than viewing, and refusing it because no `viewed` row exists would
 * be pedantry.
 */
export function updateTracked(
  db: Database,
  jobId: string,
  patch: { status?: unknown; note?: unknown },
  now: Date = new Date(),
): UpdateResult {
  if (patch.status !== undefined && !isTrackerStatus(patch.status)) {
    return { ok: false, error: `status must be one of ${APPLICATION_STATUSES.join(", ")}` };
  }
  if (patch.note !== undefined && typeof patch.note !== "string") {
    return { ok: false, error: "note must be text" };
  }
  const job = db
    .query<{ id: string }, [string]>(`SELECT id FROM jobs WHERE id = ?`)
    .get(jobId);
  if (!job) return { ok: false, error: "No such job" };

  const stamp = now.toISOString();
  markViewed(db, jobId, now);

  if (patch.status !== undefined) {
    const status = patch.status as ApplicationStatus;
    db.query(
      `UPDATE applications
          SET status = ?,
              last_status_at = ?,
              -- The date you applied is a fact about the past. Stamp it once,
              -- the first time the row reaches 'submitted', and never move it.
              submitted_at = CASE
                WHEN ? = 'submitted' AND submitted_at IS NULL THEN ?
                ELSE submitted_at END,
              prepared_at = CASE
                WHEN ? = 'prepared' AND prepared_at IS NULL THEN ?
                ELSE prepared_at END
        WHERE job_id = ?`,
    ).run(status, stamp, status, stamp, status, stamp, jobId);

    // The board's own column mirrors the decision, so the review screen and the
    // tracker never disagree about whether a job is still open.
    const review =
      status === "rejected" || status === "closed" || status === "ghosted"
        ? "rejected"
        : status === "viewed"
          ? null
          : "approved";
    if (review) {
      db.query(`UPDATE jobs SET review_status = ? WHERE id = ?`).run(review, jobId);
    }
  }

  if (patch.note !== undefined) {
    const note = (patch.note as string).trim();
    db.query(`UPDATE applications SET note = ? WHERE job_id = ?`).run(note || null, jobId);
  }

  return { ok: true };
}

/** Remove a job from the tracker entirely. */
export function untrack(db: Database, jobId: string): boolean {
  const result = db.query(`DELETE FROM applications WHERE job_id = ?`).run(jobId);
  return result.changes > 0;
}

/** The tracker as CSV, for a spreadsheet or a backup. */
export function trackedAsCsv(rows: TrackedApplication[]): string {
  const cell = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    // Quote when the value contains anything that would break a row, and double
    // any quote inside it.
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    "company", "title", "location", "status", "ai_score",
    "submitted_at", "last_status_at", "days_since", "note", "apply_url",
  ];
  const lines = rows.map((r) =>
    [r.company, r.title, r.location, r.status, r.aiScore, r.submittedAt,
     r.lastStatusAt, r.daysSince, r.note, r.applyUrl].map(cell).join(","));
  return [header.join(","), ...lines].join("\n") + "\n";
}
