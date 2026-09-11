/**
 * robots.txt, parsed and obeyed.
 *
 * Follows RFC 9309. The rules that actually bite in practice, and that a naive
 * implementation gets wrong:
 *
 *   - Consecutive `User-agent` lines share one group of rules.
 *   - A group naming us specifically wins over `*`, even when `*` appears
 *     first and even when ours has fewer rules.
 *   - The longest matching path wins, not the first. `Allow` wins a tie, which
 *     is what lets a site disallow `/jobs/` but allow `/jobs/public/`.
 *   - An empty `Disallow:` means allow everything, not disallow everything.
 *   - `*` matches any run of characters and `$` anchors the end.
 *
 * Nothing here can be overridden by a flag. A site that says no gets a no.
 */

export interface RobotsRule {
  allow: boolean;
  /** The path pattern as written, e.g. `/jobs/*\/apply$`. */
  pattern: string;
}

export interface RobotsPolicy {
  rules: RobotsRule[];
  /** Seconds the site asked us to wait between requests, if it said. */
  crawlDelay: number | null;
  /** Sitemaps are listed outside any group and apply to everyone. */
  sitemaps: string[];
  /** True when the file could not be read and we defaulted to permitting. */
  assumed: boolean;
}

export const EMPTY_POLICY: RobotsPolicy = {
  rules: [],
  crawlDelay: null,
  sitemaps: [],
  assumed: true,
};

/** Strip a comment and surrounding whitespace from one line. */
function strip(line: string): string {
  const hash = line.indexOf("#");
  return (hash >= 0 ? line.slice(0, hash) : line).trim();
}

interface Group {
  agents: string[];
  rules: RobotsRule[];
  crawlDelay: number | null;
}

/**
 * Parse robots.txt into the policy for one user agent.
 *
 * `agent` is matched case-insensitively as a prefix, which is how crawlers are
 * expected to identify themselves — a group for `jobscout` matches the agent
 * string `jobscout/0.1 (+https://…)`.
 */
export function parseRobots(text: string, agent: string): RobotsPolicy {
  const groups: Group[] = [];
  const sitemaps: string[] = [];

  let current: Group | null = null;
  // Consecutive user-agent lines share a group; a rule line closes the header.
  let collectingAgents = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = strip(raw);
    if (!line) continue;

    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!collectingAgents || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
        collectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }

    // Any other field belongs to the group being built.
    if (!current) continue;
    collectingAgents = false;

    if (field === "disallow") {
      // An empty Disallow permits everything, so it is not a rule at all.
      if (value) current.rules.push({ allow: false, pattern: value });
    } else if (field === "allow") {
      if (value) current.rules.push({ allow: true, pattern: value });
    } else if (field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
    }
  }

  const me = agent.toLowerCase();
  // A group naming us wins over the wildcard, wherever it appears in the file.
  const specific = groups.filter((g) =>
    g.agents.some((a) => a !== "*" && (me.startsWith(a) || a.startsWith(me.split("/")[0]!))),
  );
  const wildcard = groups.filter((g) => g.agents.includes("*"));
  const chosen = specific.length ? specific : wildcard;

  if (!chosen.length) return { rules: [], crawlDelay: null, sitemaps, assumed: false };

  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelay: chosen.reduce<number | null>(
      (d, g) => (g.crawlDelay === null ? d : d === null ? g.crawlDelay : Math.max(d, g.crawlDelay)),
      null,
    ),
    sitemaps,
    assumed: false,
  };
}

/** Turn a robots path pattern into a regular expression. */
function toRegExp(pattern: string): RegExp {
  let source = "";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "$") source += "$";
    else source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + source);
}

/** How much of the path a rule matched, or -1 when it did not. */
function matchLength(pattern: string, path: string): number {
  try {
    if (!toRegExp(pattern).test(path)) return -1;
  } catch {
    // A pattern we cannot compile is treated as not matching rather than
    // taking down the crawl.
    return -1;
  }
  // Wildcards make the literal length the fair comparison, per the RFC.
  return pattern.replace(/\*/g, "").replace(/\$$/, "").length;
}

/**
 * May we fetch this path?
 *
 * Longest match wins. On a tie `Allow` wins, which is the rule that makes
 * "disallow /jobs/, allow /jobs/public/" behave as the site intended.
 */
export function isAllowed(policy: RobotsPolicy, path: string): boolean {
  let bestLength = -1;
  let bestAllow = true;

  for (const rule of policy.rules) {
    const length = matchLength(rule.pattern, path);
    if (length < 0) continue;
    if (length > bestLength || (length === bestLength && rule.allow)) {
      bestLength = length;
      bestAllow = rule.allow;
    }
  }

  return bestLength < 0 ? true : bestAllow;
}

/** The path-and-query a robots rule is matched against. */
export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return "/";
  }
}
