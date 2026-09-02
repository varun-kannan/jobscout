/**
 * Client-side relevance filtering for the boards family.
 *
 * Unlike ATS boards, which return one company's openings, these sources return
 * everything they have — RemoteOK hands back 100 jobs, Arbeitnow 175, none of
 * them scoped to what you are looking for. Most offer no search parameter, so
 * the filtering happens here.
 *
 * Deliberately permissive. The match stage is what actually decides relevance,
 * with your real skill graph and a visible score; this only exists to stop the
 * database filling with roles from unrelated fields. Dropping something here is
 * invisible and unappealable, so it errs heavily towards keeping.
 */

/** Split a search term into meaningful words, ignoring filler. */
const STOPWORDS = new Set(["a", "an", "the", "and", "or", "of", "for", "in", "at", "to"]);

/**
 * Words describing *level* rather than *field*.
 *
 * These must never match on their own. Searching "senior software engineer"
 * once let through "Senior Corporate Communications Manager", "Senior Product
 * Designer" and "Senior Customer Support Specialist" — every one of them
 * matched on the single word "senior", which says nothing about the work.
 */
const SENIORITY = new Set([
  "senior",
  "sr",
  "junior",
  "jr",
  "lead",
  "staff",
  "principal",
  "mid",
  "entry",
  "level",
  "i",
  "ii",
  "iii",
  "iv",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * The words in a term that actually say what the work is.
 *
 * Falls back to every word when a term is nothing but seniority, so searching
 * for "senior" alone still behaves sensibly.
 */
function signalWords(term: string): string[] {
  const all = words(term);
  const signal = all.filter((w) => !SENIORITY.has(w));
  return signal.length > 0 ? signal : all;
}

/**
 * Does this posting plausibly relate to any configured search term?
 *
 * A term matches when *any* of its words appears in the title or tags —
 * "senior backend engineer" matches a posting titled "Backend Engineer".
 * Matching against the description was tried and rejected: nearly every
 * engineering posting mentions nearly every common term somewhere in the body.
 */
export function matchesTerms(
  terms: readonly string[],
  fields: { title: string; tags?: readonly string[] },
): boolean {
  // No terms configured means no opinion, so keep everything.
  if (terms.length === 0) return true;

  const haystack = new Set([
    ...words(fields.title),
    ...(fields.tags ?? []).flatMap((tag) => words(tag)),
  ]);

  return terms.some((term) => {
    const needed = signalWords(term);
    if (needed.length === 0) return false;
    return needed.some((word) => haystack.has(word));
  });
}

/** Drop postings older than the configured window, when a date is known. */
export function withinAge(postedAt: string | null | undefined, maxAgeDays: number): boolean {
  if (!postedAt) return true; // unknown age is not a reason to discard
  const time = Date.parse(postedAt);
  if (!Number.isFinite(time)) return true;
  const ageDays = (Date.now() - time) / 86_400_000;
  return ageDays <= maxAgeDays;
}

/** Seconds-since-epoch to ISO, for sources that return numeric timestamps. */
export function epochToIso(epoch: number | string | null | undefined): string | null {
  if (epoch == null) return null;
  const n = typeof epoch === "string" ? Number(epoch) : epoch;
  if (!Number.isFinite(n) || n <= 0) return null;
  // Values below ~10^11 are seconds; above are milliseconds.
  return new Date(n < 1e11 ? n * 1000 : n).toISOString();
}
