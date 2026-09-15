/**
 * How well a posting's location suits the places you said you can work.
 *
 * Used only to order results, never to hide them. A wrong call moves a job down
 * the list rather than out of it, which is why a keyword heuristic is good
 * enough here.
 *
 * Remote restrictions are read from the location text because the engines put
 * them there: "Remote (USA)", "Remote - Europe". The `remote_restriction`
 * column exists but no engine fills it.
 */

export const FIT = {
  /** Names one of your locations. */
  preferred: 3,
  /** Remote, and either names no region or names one that includes you. */
  remoteOpen: 2,
  /** The posting does not say where it is. */
  unstated: 1,
  /** Somewhere else, including remote roles restricted to another region. */
  elsewhere: 0,
} as const;

/** Region words that keep a remote role open to someone in India. */
const OPEN_REGIONS = ["india", "apac", "asia", "anywhere", "worldwide", "global"];

/**
 * Region markers that restrict a remote role elsewhere. Short codes are matched
 * with surrounding punctuation or spaces so "us" does not match "Russia".
 */
const RESTRICTED = [
  "united states", "usa", "u.s.", "(us)", "(us ", " us)", "- us", ", us", "us only", "us-only",
  "north america", "americas", "canada", "mexico", "latam", "brazil",
  "united kingdom", "(uk)", "- uk", ", uk", "uk only",
  "europe", "emea", "(eu)", "- eu", ", eu",
  "germany", "france", "spain", "portugal", "netherlands", "ireland", "poland",
  "australia", "new zealand", "singapore", "japan", "philippines", "israel",
];

/** Location strings that mean the posting did not say. */
const UNSTATED = ["", "n/a", "na", "-", "not specified", "unknown", "tbd"];

/** Escape LIKE wildcards in text that came from the user. */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (c) => "\\" + c);
}

/** A literal from the lists above, safe to inline: none contain quotes. */
function inline(text: string): string {
  return `'%${text}%'`;
}

/**
 * A SQL expression scoring `j.location` and `j.remote` by the tiers in FIT.
 *
 * Null when there are no preferred locations. Not a constant: SQLite reads a
 * bare integer in ORDER BY as a column position, so `ORDER BY 0` is an error.
 */
export function locationFitSql(
  preferred: readonly string[],
): { sql: string; params: string[] } | null {
  const places = [...new Set(preferred.map((p) => p.trim()).filter(Boolean))];
  if (places.length === 0) return null;

  const loc = "lower(COALESCE(j.location, ''))";
  const anyPreferred = places.map(() => `${loc} LIKE ? ESCAPE '\\'`).join(" OR ");
  const looksRemote = `(j.remote = 1 OR ${loc} LIKE '%remote%')`;
  const namesOpen = OPEN_REGIONS.map((r) => `${loc} LIKE ${inline(r)}`).join(" OR ");
  const namesRestricted = RESTRICTED.map((r) => `${loc} LIKE ${inline(r)}`).join(" OR ");
  const unstated = `trim(${loc}) IN (${UNSTATED.map((u) => `'${u}'`).join(", ")})`;

  const sql = `(CASE
    WHEN ${anyPreferred} THEN ${FIT.preferred}
    WHEN ${looksRemote} AND ((${namesOpen}) OR NOT (${namesRestricted})) THEN ${FIT.remoteOpen}
    WHEN ${unstated} THEN ${FIT.unstated}
    ELSE ${FIT.elsewhere}
  END)`;

  return { sql, params: places.map((p) => `%${likeLiteral(p.toLowerCase())}%`) };
}
