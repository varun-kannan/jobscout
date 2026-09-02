/**
 * The contract every job source implements.
 *
 * An engine does exactly one thing: retrieve records and hand them back. It
 * makes no judgements, writes nothing to the database, and knows nothing about
 * scoring or matching. That separation is what makes a broken source a source
 * bug rather than a mysterious pipeline failure — and it is why every engine
 * can be tested against a recorded response with no other machinery present.
 */

import type { Config, EngineId, Secrets } from "../config/schema.ts";
import type { SalaryRange } from "../signals/salary.ts";
import type { HttpClient } from "./http.ts";

export type EngineFamily = "ats" | "board" | "india" | "inbox" | "aggregator" | "scraper";

/**
 * How much of the posting body a source actually hands over.
 *
 * Declared per engine rather than discovered per job, because it is a fixed
 * property of the source and downstream stages need to plan around it:
 *
 *   full     the whole posting — matching and drafting both work
 *   snippet  a truncated teaser — aggregators, by design
 *   none     no body at all; Foundit returns skills instead
 *
 * Anything below `full` is what the enrichment relay looks for when deciding
 * which postings to re-fetch from an ATS board.
 */
export type DescriptionQuality = "full" | "snippet" | "none";

/** A posting exactly as the source described it, before any interpretation. */
export interface RawJob {
  /** The source's own id. Combined with the engine id to make a stable key. */
  nativeId: string;
  company: string;
  title: string;
  location: string;
  applyUrl: string;
  description: string;
  /**
   * False when the source returned a snippet rather than the whole posting.
   * Aggregators truncate; the enrichment step uses this to decide what to
   * re-fetch from an ATS board.
   */
  descriptionComplete: boolean;
  remote?: boolean | null;
  salary?: SalaryRange;
  postedAt?: string | null;
  employmentType?: string | null;
  /** Some sources hand over skills already structured. Foundit does. */
  skills?: string[];
  /** The untouched payload, kept so nothing is lost to a parsing mistake. */
  raw: unknown;
}

/** A company board an ATS engine should poll. */
export interface Board {
  company: string;
  ats: string;
  token: string;
}

export interface SearchQuery {
  terms: string[];
  locations: string[];
  remoteOnly: boolean;
  /** Ignore anything older than this, when the source supports it. */
  maxAgeDays: number;
}

export interface EngineContext {
  config: Config;
  secrets: Secrets;
  query: SearchQuery;
  http: HttpClient;
  /** Boards for this engine's ATS only; empty for non-ATS engines. */
  boards: Board[];
  signal: AbortSignal;
}

export type Readiness = { ok: true } | { ok: false; reason: string };

export interface Engine {
  id: EngineId;
  family: EngineFamily;
  /** Human-facing name for progress output. */
  label: string;
  /** True when it needs no credential and no extra runtime. */
  keyless: boolean;
  /** How complete the descriptions from this source are. */
  descriptionQuality: DescriptionQuality;
  /**
   * Can this engine run right now? Checked before fetching so a missing key is
   * reported as `skipped` with a reason rather than surfacing as an error.
   */
  ready(ctx: EngineContext): Readiness;
  fetch(ctx: EngineContext): Promise<RawJob[]>;
}

export const READY: Readiness = { ok: true };

export function notReady(reason: string): Readiness {
  return { ok: false, reason };
}

/**
 * Coerce a payload field into an array.
 *
 * `value ?? []` only guards against null; a source returning an object where an
 * array was expected — an error envelope, a shape change — then crashes the
 * engine with "is not iterable" rather than reporting an empty result.
 */
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Trim, collapse whitespace, and turn null-ish values into "". */
export function clean(value: unknown): string {
  if (value == null) return "";
  const text = String(value);
  if (text === "null" || text === "undefined" || text === "nan") return "";
  return text.replace(/\s+/g, " ").trim();
}

/** Strip HTML to readable text — most ATS platforms return HTML descriptions. */
export function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Does this posting look remote?
 *
 * Deliberately conservative: it answers from the location field only, and
 * returns null rather than guessing when the text says nothing. Detecting the
 * "remote, but US-only" trap needs the full description and belongs to the
 * normalise stage, not here.
 */
export function looksRemote(location: string, title = ""): boolean | null {
  const text = `${location} ${title}`.toLowerCase();
  if (/\b(remote|work from home|wfh|anywhere|distributed)\b/.test(text)) return true;
  if (/\b(on-?site|in-?office|hybrid)\b/.test(text)) return false;
  return null;
}

/**
 * Prefer what the source actually said over what its location string implies.
 *
 * The subtlety is `false`: several sources return an explicit `remote: false`,
 * and treating that as "no answer" sends it back to `looksRemote`, which then
 * guesses from a city name and returns null. An explicit negative is an answer
 * and must be kept.
 */
export function remoteFrom(
  explicit: boolean | null | undefined,
  location: string,
  title = "",
): boolean | null {
  if (typeof explicit === "boolean") return explicit;
  return looksRemote(location, title);
}
