/**
 * Turning a snippet into a real posting.
 *
 * Aggregators find roles the ATS engines have never heard of, but hand back a
 * headline and a redirect. Foundit returns skills and no body at all. This is
 * the relay that closes the gap: when a company with a truncated posting turns
 * out to have a board jobscout already polls, the full description is fetched
 * from source.
 *
 * Entirely deterministic — no model involved. It is company-name matching and
 * an HTTP request.
 */

import type { Database } from "bun:sqlite";
import type { Board, RawJob } from "../engines/engine.ts";
import type { HttpClient } from "../engines/http.ts";
import { getEngine } from "../engines/registry.ts";
import { activeBoards } from "../db/jobs.ts";
import type { Config, EngineId, Secrets } from "../config/schema.ts";

export interface EnrichSummary {
  candidates: number;
  boardsQueried: number;
  enriched: number;
  unmatched: number;
}

/**
 * Compare company names loosely enough to survive suffixes and punctuation.
 *
 * "Stripe", "Stripe, Inc." and "Stripe Inc" are one employer. Deliberately
 * conservative: a false pairing would attach the wrong description to a job,
 * which is worse than leaving it a snippet.
 */
function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(
      /\b(inc|incorporated|llc|ltd|limited|corp|corporation|gmbh|bv|plc|pvt|private|technologies|technology|labs|group|holdings|india|global)\b/g,
      " ",
    )
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/** Postings worth trying to complete. */
interface Candidate {
  id: string;
  company: string;
  title: string;
}

function candidates(db: Database): Candidate[] {
  return db
    .query<Candidate, []>(
      `SELECT id, company, title FROM jobs
       WHERE description_complete = 0 AND company <> ''
       ORDER BY company`,
    )
    .all();
}

/** Match two titles loosely — same role, differently punctuated. */
function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface EnrichOptions {
  http: HttpClient;
  config: Config;
  secrets: Secrets;
  signal?: AbortSignal;
  onProgress?(message: string): void;
}

/**
 * Fetch full descriptions for truncated postings whose employer has a board.
 *
 * Boards are fetched once each and reused across every candidate from that
 * company, so a company with thirty snippets costs one request, not thirty.
 */
export async function enrichSnippets(
  db: Database,
  options: EnrichOptions,
): Promise<EnrichSummary> {
  const pending = candidates(db);
  const summary: EnrichSummary = {
    candidates: pending.length,
    boardsQueried: 0,
    enriched: 0,
    unmatched: 0,
  };
  if (pending.length === 0) return summary;

  const boards = activeBoards(db);
  const boardsByCompany = new Map<string, Board[]>();
  for (const board of boards) {
    const key = companyKey(board.company);
    const list = boardsByCompany.get(key) ?? [];
    list.push(board);
    boardsByCompany.set(key, list);
  }

  // company key → its postings, fetched at most once
  const fetched = new Map<string, RawJob[]>();

  const update = db.prepare(
    `UPDATE jobs SET description = ?, description_complete = 1 WHERE id = ?`,
  );

  for (const candidate of pending) {
    const key = companyKey(candidate.company);
    const companyBoards = boardsByCompany.get(key);
    if (!companyBoards?.length) {
      summary.unmatched++;
      continue;
    }

    if (!fetched.has(key)) {
      const collected: RawJob[] = [];
      for (const board of companyBoards) {
        const engine = getEngine(board.ats as EngineId);
        if (!engine) continue;
        try {
          summary.boardsQueried++;
          options.onProgress?.(`fetching ${board.company} from ${board.ats}`);
          const jobs = await engine.fetch({
            config: options.config,
            secrets: options.secrets,
            query: { terms: [], locations: [], remoteOnly: false, maxAgeDays: 365 },
            http: options.http,
            boards: [board],
            signal: options.signal ?? new AbortController().signal,
          });
          collected.push(...jobs);
        } catch {
          // A board failing here costs a description, not the run.
        }
      }
      fetched.set(key, collected);
    }

    const pool = fetched.get(key) ?? [];
    const wanted = titleKey(candidate.title);
    const match = pool.find((j) => titleKey(j.title) === wanted && j.description.length > 200);

    if (match) {
      update.run(match.description, candidate.id);
      summary.enriched++;
    } else {
      summary.unmatched++;
    }
  }

  return summary;
}
