/**
 * Finding which applicant tracking system a company uses.
 *
 * This is what turns the ATS family from "companies I happened to list" into
 * real coverage. A live check during design found only 2 of 12 Indian companies
 * on Greenhouse — but Meesho and CRED both resolved on Lever. The postings were
 * there; the tokens were not known.
 *
 * Two tiers, cheapest first:
 *
 *   1. **Probe.** Most companies use their own name as the board token, so
 *      slugified guesses are tried against each platform. Free, no model, and
 *      it resolves the majority.
 *   2. **Ask.** Only for companies the probe misses.
 *
 * Nothing is saved unverified. A token that does not return jobs is worse than
 * no token: it makes an engine look broken every run.
 */

import type { HttpClient } from "./http.ts";
import type { Board } from "./engine.ts";

/** Platforms whose boards can be probed by name. */
export const PROBEABLE_ATS = ["greenhouse", "lever", "ashby", "recruitee"] as const;
export type ProbeableAts = (typeof PROBEABLE_ATS)[number];

/** Plausible board tokens for a company name, most likely first. */
export function candidateTokens(company: string): string[] {
  const base = company
    .toLowerCase()
    .replace(/[.,'’]/g, "")
    .replace(
      /\b(inc|incorporated|llc|ltd|limited|corp|corporation|gmbh|bv|plc|pvt|private|technologies|technology|labs|group|holdings)\b/g,
      " ",
    )
    .trim();

  const words = base.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return [];

  // Only the full name, joined and hyphenated.
  //
  // A bare first word was tried and removed: it matched "Capital One" to
  // `lever/capital`, a company in Limassol with 36 unrelated jobs. It also
  // earns nothing, because suffix-stripping already reduces "Meesho
  // Technologies" to "meesho" — the case it was meant to catch.
  return [...new Set([words.join(""), words.join("-")])].filter((t) => t.length >= 2);
}

export interface ProbeResult {
  company: string;
  ats: ProbeableAts;
  token: string;
  jobs: number;
}

/**
 * Does this token resolve to a board with jobs on it?
 *
 * Deliberately checks for *jobs*, not merely a 200. Several platforms answer
 * successfully for a token that does not exist, returning an empty board — so
 * a status check alone would happily save nonsense.
 */
/** Do two company names plausibly refer to the same employer? */
export function namesAgree(a: string, b: string): boolean {
  const key = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const x = key(a);
  const y = key(b);
  if (!x || !y) return true;
  return x.includes(y) || y.includes(x);
}

async function probeOne(
  http: HttpClient,
  ats: ProbeableAts,
  token: string,
  signal?: AbortSignal,
  expected?: string,
): Promise<number> {
  const options = { signal, retries: 0, timeoutMs: 12_000 };
  try {
    switch (ats) {
      case "greenhouse": {
        const data = await http.json<{ jobs?: Array<{ company_name?: string }> }>(
          `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`,
          options,
        );
        if (!Array.isArray(data.jobs) || data.jobs.length === 0) return 0;
        // Greenhouse names the employer, so a token that resolves to someone
        // else can be caught rather than saved.
        const named = data.jobs.find((j) => j.company_name)?.company_name;
        if (named && expected && !namesAgree(named, expected)) return 0;
        return data.jobs.length;
      }
      case "lever": {
        const data = await http.json<unknown>(
          `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`,
          options,
        );
        // A missing token returns an object, not an array.
        return Array.isArray(data) ? data.length : 0;
      }
      case "recruitee": {
        const data = await http.json<{ offers?: unknown[] }>(
          `https://${encodeURIComponent(token)}.recruitee.com/api/offers/`,
          options,
        );
        return Array.isArray(data.offers) ? data.offers.length : 0;
      }
      case "ashby": {
        const data = await http.json<{
          data?: { jobBoard?: { jobPostings?: unknown[] } | null };
          errors?: unknown[];
        }>("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams", {
          ...options,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operationName: "ApiJobBoardWithTeams",
            variables: { organizationHostedJobsPageName: token },
            query:
              "query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) { jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) { jobPostings { id } } }",
          }),
        });
        if (data.errors?.length) return 0;
        return data.data?.jobBoard?.jobPostings?.length ?? 0;
      }
    }
  } catch {
    // A miss is the normal case here, not an error worth surfacing.
    return 0;
  }
}

export interface ProbeOptions {
  http: HttpClient;
  signal?: AbortSignal;
  /** Platforms to try, in order. */
  platforms?: readonly ProbeableAts[];
  onProgress?(company: string, attempt: number, total: number): void;
}

/**
 * Probe one company across platforms, stopping at the first real board.
 *
 * Stops early on purpose: a company is almost never on two systems at once, and
 * continuing would cost requests for no gain.
 */
export async function probeCompany(
  company: string,
  options: ProbeOptions,
): Promise<ProbeResult | null> {
  const tokens = candidateTokens(company);
  const platforms = options.platforms ?? PROBEABLE_ATS;

  for (const token of tokens) {
    for (const ats of platforms) {
      const jobs = await probeOne(options.http, ats, token, options.signal, company);
      if (jobs > 0) return { company, ats, token, jobs };
    }
  }
  return null;
}

export interface DiscoverySummary {
  tried: number;
  found: ProbeResult[];
  missed: string[];
}

/** Probe many companies, sequentially so no platform is hammered. */
export async function probeCompanies(
  companies: readonly string[],
  options: ProbeOptions,
): Promise<DiscoverySummary> {
  const summary: DiscoverySummary = { tried: companies.length, found: [], missed: [] };

  for (const [index, company] of companies.entries()) {
    options.onProgress?.(company, index + 1, companies.length);
    const result = await probeCompany(company, options);
    if (result) summary.found.push(result);
    else summary.missed.push(company);
  }

  return summary;
}

/** Verify a board still resolves — used to drop stale tokens. */
export async function verifyBoard(
  board: Board,
  options: ProbeOptions,
): Promise<boolean> {
  if (!(PROBEABLE_ATS as readonly string[]).includes(board.ats)) return true;
  const jobs = await probeOne(options.http, board.ats as ProbeableAts, board.token, options.signal);
  return jobs > 0;
}
