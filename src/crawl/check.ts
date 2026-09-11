/**
 * Checking which postings are still open.
 *
 * Picks what to check, fetches it through the crawler, records the verdict.
 * The ordering is deliberate: the postings you are most likely to act on are
 * checked first, so a run that hits its budget has still answered the question
 * that mattered.
 */

import type { Database } from "bun:sqlite";
import { Crawler, type CrawlerOptions } from "./crawler.ts";
import { assessLiveness, type Liveness } from "./liveness.ts";

export interface CheckOptions {
  /** Only postings whose location contains this. */
  location?: string;
  /** Skip anything checked within this many days. */
  recheckAfterDays?: number;
  /** Most postings to check in one run. */
  limit?: number;
  /** Only postings older than this, where the answer is most likely to matter. */
  olderThanDays?: number;
  /** Re-check even things marked closed, in case a posting reopened. */
  includeClosed?: boolean;
  onProgress?(done: number, total: number, company: string, state: Liveness): void;
}

export interface CheckSummary {
  considered: number;
  checked: number;
  counts: Record<Liveness, number>;
  /** True when the crawler's request budget ran out mid-run. */
  budgetExhausted: boolean;
}

interface Row {
  id: string;
  company: string;
  apply_url: string;
}

/** Build the candidate list: what is worth asking about, best first. */
export function candidates(db: Database, options: CheckOptions = {}): Row[] {
  const clauses: string[] = [
    `COALESCE(j.apply_url,'') <> ''`,
    `j.canonical_id IS NULL`,
  ];
  const params: (string | number)[] = [];

  if (!options.includeClosed) {
    // No point re-asking about something already known to be gone.
    clauses.push(`COALESCE(j.liveness,'unknown') NOT IN ('closed','gone')`);
  }
  if (options.recheckAfterDays !== undefined) {
    clauses.push(
      `(j.liveness_checked_at IS NULL
        OR j.liveness_checked_at < datetime('now', ?))`,
    );
    params.push(`-${options.recheckAfterDays} day`);
  }
  if (options.olderThanDays !== undefined) {
    // A posting with no date is included: unknown age is not proof of freshness.
    clauses.push(`(j.posted_at IS NULL OR j.posted_at < datetime('now', ?))`);
    params.push(`-${options.olderThanDays} day`);
  }
  if (options.location?.trim()) {
    clauses.push(`j.location LIKE ?`);
    params.push(`%${options.location.trim()}%`);
  }

  const limit = Math.max(1, options.limit ?? 500);
  params.push(limit);

  return db
    .query<Row, (string | number)[]>(
      `SELECT j.id, j.company, j.apply_url
       FROM jobs j
       LEFT JOIN matches m ON m.job_id = j.id
       LEFT JOIN scores  s ON s.job_id = j.id
       WHERE ${clauses.join(" AND ")}
       -- Best first, so a run cut short by its budget has still answered the
       -- question about the jobs you were most likely to apply to.
       ORDER BY s.ai_score DESC NULLS LAST, m.match_score DESC NULLS LAST
       LIMIT ?`,
    )
    .all(...params);
}

const EMPTY_COUNTS = (): Record<Liveness, number> => ({
  open: 0, closed: 0, gone: 0, unreachable: 0, unknown: 0,
});

export async function checkLiveness(
  db: Database,
  options: CheckOptions & { crawler?: CrawlerOptions } = {},
): Promise<CheckSummary> {
  const rows = candidates(db, options);
  const summary: CheckSummary = {
    considered: rows.length,
    checked: 0,
    counts: EMPTY_COUNTS(),
    budgetExhausted: false,
  };
  if (rows.length === 0) return summary;

  const crawler = new Crawler({ db, ...options.crawler });
  const save = db.prepare(
    `UPDATE jobs SET liveness = ?, liveness_reason = ?, liveness_checked_at = ? WHERE id = ?`,
  );

  for (const [index, row] of rows.entries()) {
    const result = await crawler.fetchUrl(row.apply_url);

    // The budget is the crawler's, and it reports it by refusing. Stopping here
    // leaves the rest unchecked rather than recording a verdict we never made.
    if (crawler.stats.budgetExhausted) {
      summary.budgetExhausted = true;
      break;
    }

    const verdict = assessLiveness({
      url: row.apply_url,
      outcome: result.outcome,
      status: result.status,
      finalUrl: result.finalUrl,
      body: result.body,
    });

    save.run(verdict.state, verdict.reason, new Date().toISOString(), row.id);
    summary.checked++;
    summary.counts[verdict.state]++;
    options.onProgress?.(index + 1, rows.length, row.company, verdict.state);
  }

  return summary;
}
