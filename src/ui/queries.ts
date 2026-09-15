/**
 * Everything the web UI reads, as plain functions over the database.
 *
 * Kept separate from the server so the shape of a response is testable without
 * binding a port, and so the same queries could back another front end. No
 * function here writes; the two that do live in `mutations`.
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { rankingFreshness, currentFingerprint, type Freshness } from "../skills/fingerprint.ts";

export interface JobSummary {
  id: string;
  company: string;
  title: string;
  location: string;
  engine: string;
  remote: number | null;
  applyUrl: string;
  matchedRequired: number;
  totalRequired: number;
  coverage: number;
  matchScore: number;
  aiScore: number | null;
  wlbScore: number | null;
  salaryVsTarget: string | null;
  reviewStatus: string | null;
  postedAt: string | null;
  companyType: string | null;
  liveness: string | null;
  livenessReason: string | null;
}

export interface JobFilters {
  /** Substring match on company, title or location. */
  q?: string;
  location?: string;
  company?: string;
  /** Minimum AI score; postings with none are excluded when set. */
  minAiScore?: number;
  minCoverage?: number;
  remoteOnly?: boolean;
  status?: string;
  companyType?: string;
  liveness?: string;
  /** Only postings published within this many days. Undated postings are excluded. */
  postedWithinDays?: number;
  sort?: "score" | "coverage" | "posted" | "company";
  limit?: number;
  offset?: number;
}

/** Columns a caller may sort by, mapped to SQL. Never interpolate user input. */
const SORTS: Record<string, string> = {
  score: "s.ai_score DESC NULLS LAST, m.match_score DESC",
  coverage: "m.coverage DESC, m.match_score DESC",
  posted: "j.posted_at DESC NULLS LAST",
  company: "j.company COLLATE NOCASE ASC, j.title ASC",
};

const SUMMARY_SELECT = `
  SELECT j.id, j.company, j.title, COALESCE(j.location,'') AS location, j.engine,
         j.remote, COALESCE(j.apply_url,'') AS applyUrl,
         COALESCE(m.matched_required,0) AS matchedRequired,
         COALESCE(m.total_required,0)   AS totalRequired,
         COALESCE(m.coverage,0)         AS coverage,
         COALESCE(m.match_score,0)      AS matchScore,
         s.ai_score AS aiScore, g.wlb_score AS wlbScore,
         g.salary_vs_target AS salaryVsTarget,
         j.review_status AS reviewStatus, j.posted_at AS postedAt,
         j.company_type AS companyType,
         j.liveness AS liveness, j.liveness_reason AS livenessReason
  FROM jobs j
  LEFT JOIN matches m ON m.job_id = j.id
  LEFT JOIN scores  s ON s.job_id = j.id
  LEFT JOIN signals g ON g.job_id = j.id
  WHERE j.canonical_id IS NULL`;

/**
 * Build the WHERE additions and their bindings together, so a filter can never
 * be added to one without the other.
 */
function conditions(filters: JobFilters): { sql: string; params: SQLQueryBindings[] } {
  const sql: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filters.q?.trim()) {
    sql.push(`AND (j.company LIKE ? OR j.title LIKE ? OR j.location LIKE ?)`);
    const like = `%${filters.q.trim()}%`;
    params.push(like, like, like);
  }
  if (filters.location?.trim()) {
    sql.push(`AND j.location LIKE ?`);
    params.push(`%${filters.location.trim()}%`);
  }
  if (filters.company?.trim()) {
    sql.push(`AND j.company = ?`);
    params.push(filters.company.trim());
  }
  if (typeof filters.minAiScore === "number") {
    // A posting with no score is not a zero: it has not been judged, so it is
    // excluded rather than ranked last.
    sql.push(`AND s.ai_score IS NOT NULL AND s.ai_score >= ?`);
    params.push(filters.minAiScore);
  }
  if (typeof filters.minCoverage === "number") {
    sql.push(`AND COALESCE(m.coverage,0) >= ?`);
    params.push(filters.minCoverage);
  }
  if (filters.remoteOnly) sql.push(`AND j.remote = 1`);
  if (typeof filters.postedWithinDays === "number" && filters.postedWithinDays > 0) {
    // An undated posting is not known to be recent, so a date window excludes it.
    sql.push(`AND j.posted_at IS NOT NULL AND julianday(j.posted_at) >= julianday('now', ?)`);
    params.push(`-${Math.floor(filters.postedWithinDays)} day`);
  }
  if (filters.liveness?.trim()) {
    const wanted = filters.liveness.trim();
    // "unchecked" is the absence of a value; "hideClosed" is the useful default
    // for browsing, since a closed posting is not a candidate.
    if (wanted === "unchecked") sql.push(`AND j.liveness IS NULL`);
    else if (wanted === "open-or-unknown") {
      sql.push(`AND COALESCE(j.liveness,'unknown') NOT IN ('closed','gone')`);
    } else {
      sql.push(`AND j.liveness = ?`);
      params.push(wanted);
    }
  }
  if (filters.companyType?.trim()) {
    const wanted = filters.companyType.trim();
    // "unclassified" is the absence of a value, which a plain equality test
    // would silently never match.
    if (wanted === "unclassified") sql.push(`AND j.company_type IS NULL`);
    else {
      sql.push(`AND j.company_type = ?`);
      params.push(wanted);
    }
  }
  if (filters.status?.trim()) {
    const status = filters.status.trim();
    // "undecided" is the useful filter, and it is not a stored value: the
    // pipeline writes 'new', then 'scored'/'drafted'. Only approved and
    // rejected are decisions, so everything else is still to be looked at.
    if (status === "undecided") {
      sql.push(`AND COALESCE(j.review_status,'new') NOT IN ('approved','rejected')`);
    } else {
      sql.push(`AND COALESCE(j.review_status,'new') = ?`);
      params.push(status);
    }
  }
  return { sql: sql.join(" "), params };
}

export function listJobs(db: Database, filters: JobFilters = {}): JobSummary[] {
  const { sql, params } = conditions(filters);
  const order = SORTS[filters.sort ?? "score"] ?? SORTS.score;
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 1000);
  const offset = Math.max(filters.offset ?? 0, 0);
  return db
    .query<JobSummary, SQLQueryBindings[]>(`${SUMMARY_SELECT} ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
}

export function countJobs(db: Database, filters: JobFilters = {}): number {
  const { sql, params } = conditions(filters);
  const row = db
    .query<{ n: number }, SQLQueryBindings[]>(
      `SELECT COUNT(*) AS n FROM jobs j
       LEFT JOIN matches m ON m.job_id = j.id
       LEFT JOIN scores  s ON s.job_id = j.id
       LEFT JOIN signals g ON g.job_id = j.id
       WHERE j.canonical_id IS NULL ${sql}`,
    )
    .get(...params);
  return row?.n ?? 0;
}

export interface JobDetail extends JobSummary {
  description: string;
  descriptionComplete: number;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  remoteRestriction: string | null;
  matched: string[];
  missing: string[];
  bonus: string[];
  reason: string | null;
  concerns: string[];
  redFlags: string[];
  greenFlags: string[];
  wlbEvidence: { quote: string; polarity: string; note: string }[];
  interviewStages: number | null;
  repostCount: number | null;
}

/** Parse a JSON column that may be absent or malformed, without throwing. */
function jsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function getJob(db: Database, id: string): JobDetail | null {
  const row = db
    .query<Record<string, unknown>, [string]>(
      `${SUMMARY_SELECT} AND j.id = ?
       -- The summary select already joins everything; the extra columns are
       -- pulled here rather than widening it for every list request.
       LIMIT 1`,
    )
    .get(id);
  if (!row) return null;

  const extra = db
    .query<Record<string, unknown>, [string]>(
      `SELECT j.description, j.description_complete, j.salary_min, j.salary_max,
              j.salary_currency, j.salary_period, j.remote_restriction,
              m.matched, m.missing, m.bonus,
              s.reason, s.concerns,
              g.red_flags, g.green_flags, g.wlb_evidence, g.interview_stages, g.repost_count
       FROM jobs j
       LEFT JOIN matches m ON m.job_id = j.id
       LEFT JOIN scores  s ON s.job_id = j.id
       LEFT JOIN signals g ON g.job_id = j.id
       WHERE j.id = ?`,
    )
    .get(id);

  return {
    ...(row as unknown as JobSummary),
    description: (extra?.description as string) ?? "",
    descriptionComplete: (extra?.description_complete as number) ?? 0,
    salaryMin: (extra?.salary_min as number) ?? null,
    salaryMax: (extra?.salary_max as number) ?? null,
    salaryCurrency: (extra?.salary_currency as string) ?? null,
    salaryPeriod: (extra?.salary_period as string) ?? null,
    remoteRestriction: (extra?.remote_restriction as string) ?? null,
    matched: jsonArray<string>((extra?.matched as string) ?? null),
    missing: jsonArray<string>((extra?.missing as string) ?? null),
    bonus: jsonArray<string>((extra?.bonus as string) ?? null),
    reason: (extra?.reason as string) ?? null,
    concerns: jsonArray<string>((extra?.concerns as string) ?? null),
    redFlags: jsonArray<string>((extra?.red_flags as string) ?? null),
    greenFlags: jsonArray<string>((extra?.green_flags as string) ?? null),
    wlbEvidence: jsonArray((extra?.wlb_evidence as string) ?? null),
    interviewStages: (extra?.interview_stages as number) ?? null,
    repostCount: (extra?.repost_count as number) ?? null,
  };
}

export interface Dashboard {
  jobs: number;
  ranked: number;
  scored: number;
  signalled: number;
  approved: number;
  rejected: number;
  pending: number;
  companies: number;
  boards: number;
  engines: { engine: string; jobs: number; status: string; lastRun: string | null }[];
  spend: { period: string; total: number };
  /** The share of ranked postings that have an AI score, 0-1. */
  scoreCoverage: number;
  liveness: { open: number; closed: number; gone: number; unreachable: number; unchecked: number };
  /** How much of the ranking still reflects the résumé as it stands. */
  freshness: Freshness;
  profileFingerprint: string;
  profileSkills: number;
}

export function dashboard(db: Database): Dashboard {
  const fingerprint = currentFingerprint(db);
  const one = <T>(sql: string): T =>
    db.query<T, []>(sql).get() ?? ({} as T);

  const counts = one<{
    jobs: number; ranked: number; scored: number; signalled: number; companies: number;
  }>(`SELECT
        (SELECT COUNT(*) FROM jobs WHERE canonical_id IS NULL) AS jobs,
        (SELECT COUNT(*) FROM matches)  AS ranked,
        (SELECT COUNT(*) FROM scores)   AS scored,
        (SELECT COUNT(*) FROM signals)  AS signalled,
        (SELECT COUNT(DISTINCT company) FROM jobs) AS companies`);

  const review = one<{ approved: number; rejected: number; pending: number }>(
    `SELECT
       SUM(CASE WHEN review_status='approved' THEN 1 ELSE 0 END) AS approved,
       SUM(CASE WHEN review_status='rejected' THEN 1 ELSE 0 END) AS rejected,
       SUM(CASE WHEN COALESCE(review_status,'new') NOT IN ('approved','rejected')
                THEN 1 ELSE 0 END) AS pending
     FROM jobs WHERE canonical_id IS NULL`,
  );

  const boards = one<{ n: number }>(`SELECT COUNT(*) AS n FROM boards WHERE active = 1`);

  const engines = db
    .query<{ engine: string; jobs: number; status: string; lastRun: string | null }, []>(
      `SELECT j.engine AS engine, COUNT(*) AS jobs,
              COALESCE((SELECT r.status FROM engine_runs r
                        WHERE r.engine = j.engine ORDER BY r.started_at DESC LIMIT 1), 'unknown') AS status,
              (SELECT r.started_at FROM engine_runs r
               WHERE r.engine = j.engine ORDER BY r.started_at DESC LIMIT 1) AS lastRun
       FROM jobs j GROUP BY j.engine ORDER BY COUNT(*) DESC`,
    )
    .all();

  const spend = one<{ total: number }>(
    `SELECT COALESCE(SUM(estimated_usd),0) AS total FROM ai_spend`,
  );

  return {
    jobs: counts.jobs ?? 0,
    ranked: counts.ranked ?? 0,
    scored: counts.scored ?? 0,
    signalled: counts.signalled ?? 0,
    companies: counts.companies ?? 0,
    approved: review.approved ?? 0,
    rejected: review.rejected ?? 0,
    pending: review.pending ?? 0,
    boards: boards.n ?? 0,
    engines,
    spend: { period: "all time", total: spend.total ?? 0 },
    // Surfacing this was the point: 106 of 1,691 ranked is easy to miss in a
    // list and obvious as a number.
    scoreCoverage: counts.ranked ? (counts.scored ?? 0) / counts.ranked : 0,
    liveness: one<{ open: number; closed: number; gone: number; unreachable: number; unchecked: number }>(
      `SELECT
         SUM(CASE WHEN liveness='open' THEN 1 ELSE 0 END)        AS open,
         SUM(CASE WHEN liveness='closed' THEN 1 ELSE 0 END)      AS closed,
         SUM(CASE WHEN liveness='gone' THEN 1 ELSE 0 END)        AS gone,
         SUM(CASE WHEN liveness='unreachable' THEN 1 ELSE 0 END) AS unreachable,
         SUM(CASE WHEN liveness IS NULL THEN 1 ELSE 0 END)       AS unchecked
       FROM jobs WHERE canonical_id IS NULL`),
    freshness: rankingFreshness(db, fingerprint),
    profileFingerprint: fingerprint,
    profileSkills:
      db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM profile_skills`).get()?.n ?? 0,
  };
}

/** Distinct values worth offering as filters, with counts. */
export function facets(db: Database): {
  companies: { value: string; n: number }[];
  locations: { value: string; n: number }[];
} {
  const top = (column: string) =>
    db
      .query<{ value: string; n: number }, []>(
        `SELECT ${column} AS value, COUNT(*) AS n FROM jobs
         WHERE canonical_id IS NULL AND ${column} IS NOT NULL AND ${column} <> ''
         GROUP BY ${column} ORDER BY n DESC, value LIMIT 40`,
      )
      .all();
  return { companies: top("company"), locations: top("location") };
}
