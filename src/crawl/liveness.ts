/**
 * Is this posting still open?
 *
 * There is no general answer, because no two job boards agree on how to say
 * no. Every rule below was found by fetching a live posting and a fabricated
 * one from the same board and comparing:
 *
 *   Greenhouse  redirects a dead posting to `<board>?error=true` and returns
 *               200 — a status check alone reports every dead job as open.
 *   Lever       returns a clean 404.
 *   Ashby       returns 200 for both, being a single-page app; the dead one
 *               has no `og:title` and falls back to `<title>Jobs</title>`.
 *   Recruitee   redirects off the board host when the board itself is gone.
 *
 * `unreachable` is deliberately distinct from `closed`. LinkedIn disallows us
 * in robots.txt and Foundit returns 403, so for those we genuinely do not know
 * — and reporting "closed" would delete real jobs from your list on the
 * strength of a site we were never allowed to ask.
 */

export type Liveness = "open" | "closed" | "gone" | "unreachable" | "unknown";

export interface LivenessVerdict {
  state: Liveness;
  /** Why, in a few words, so a wrong call can be argued with. */
  reason: string;
}

/** The part of a crawl result liveness depends on. */
export interface LivenessInput {
  url: string;
  outcome: string;
  status: number | null;
  finalUrl: string | null;
  body: string | null;
}

/** Phrases that mean closed wherever they appear. */
const CLOSED_PHRASES = [
  /no longer accepting applications/i,
  /this (?:job|position|posting|role) (?:is|has been) (?:no longer|closed|filled|removed)/i,
  /position has been filled/i,
  /applications? (?:are )?(?:now )?closed/i,
  /this (?:job|posting) is no longer available/i,
  /vacancy (?:is )?(?:closed|expired)/i,
];

function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** Does the page carry an Open Graph title? Ashby's dead pages do not. */
export function hasOgTitle(body: string): boolean {
  const match = body.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i)
    ?? body.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i);
  return Boolean(match && match[1] && match[1].trim().length > 0);
}

/**
 * Decide whether a posting is still open from what the crawl returned.
 *
 * Host rules are consulted before the generic phrase search, because a board
 * listing page can easily contain the words "no longer accepting applications"
 * for some other posting on it.
 */
export function assessLiveness(input: LivenessInput): LivenessVerdict {
  // A site we were not allowed to ask, or could not reach, tells us nothing.
  if (input.outcome === "disallowed") {
    return { state: "unreachable", reason: "robots.txt disallows this path" };
  }
  if (input.outcome === "blocked") {
    return { state: "unreachable", reason: "rate limited" };
  }
  if (input.outcome === "error") {
    return {
      state: "unreachable",
      reason: input.status === 403 ? "403 — the site blocks us" : `could not fetch${input.status ? ` (HTTP ${input.status})` : ""}`,
    };
  }
  if (input.outcome === "gone") return { state: "gone", reason: "HTTP 410 — removed for good" };
  if (input.outcome === "not_found") return { state: "closed", reason: "HTTP 404" };

  // `not_modified` means the page is byte-identical to last time, which is
  // evidence it has not been taken down.
  if (input.outcome === "not_modified") {
    return { state: "open", reason: "unchanged since the last check" };
  }
  if (input.outcome !== "ok") return { state: "unknown", reason: `outcome ${input.outcome}` };

  const host = hostOf(input.url);
  const finalUrl = input.finalUrl ?? input.url;
  const finalHost = hostOf(finalUrl);
  const body = input.body ?? "";

  // Greenhouse: a dead posting redirects to the board with ?error=true.
  if (host.includes("greenhouse.io")) {
    if (finalUrl.includes("error=true")) {
      return { state: "closed", reason: "Greenhouse redirected to the board" };
    }
    return { state: "open", reason: "still on its own page" };
  }

  // Ashby: a single-page app, so both states return 200. A live posting always
  // carries an og:title; the dead one falls back to the board's own page.
  if (host.includes("ashbyhq.com")) {
    if (!hasOgTitle(body)) {
      return { state: "closed", reason: "Ashby page has no posting title" };
    }
    return { state: "open", reason: "posting title present" };
  }

  // Recruitee: the board itself disappears, redirecting to recruitee.com.
  if (host.includes("recruitee.com")) {
    if (finalHost === "recruitee.com" || finalHost === "www.recruitee.com") {
      return { state: "closed", reason: "board no longer exists" };
    }
    return { state: "open", reason: "still on its board" };
  }

  // A redirect away from the posting's own host usually means it is gone.
  if (finalHost && host && finalHost !== host) {
    return { state: "closed", reason: `redirected to ${finalHost}` };
  }

  const phrase = CLOSED_PHRASES.find((p) => p.test(body));
  if (phrase) return { state: "closed", reason: "the page says applications are closed" };

  return { state: "open", reason: "no sign it has been taken down" };
}

/** Whether a verdict should stop a posting appearing in your shortlist. */
export function hidesFromShortlist(state: Liveness): boolean {
  return state === "closed" || state === "gone";
}
