/**
 * Which profile a ranking was computed against.
 *
 * A match is derived from your skills, so replacing your résumé silently
 * invalidates every one of them. Without a record of the profile used, nothing
 * can tell a current ranking from one computed against a résumé you replaced
 * hours ago — the dashboard reported seven thousand rankings as though they
 * meant something, when all of them predated the CV they claimed to reflect.
 *
 * The fingerprint is over what actually changes a score: the skill and the
 * depth claimed for it. Re-extracting the same résumé produces the same
 * fingerprint, so nothing is invalidated for no reason.
 */

import type { Database } from "bun:sqlite";

export interface FingerprintInput {
  slug: string;
  level: string;
}

/**
 * A stable short hash of a profile.
 *
 * Sorted first, so the order rows come back in cannot change the answer.
 */
export function fingerprintOf(skills: readonly FingerprintInput[]): string {
  if (skills.length === 0) return "empty";
  const canonical = [...skills]
    .map((s) => `${s.slug}:${s.level}`)
    .sort()
    .join("|");
  return Bun.hash(canonical).toString(36);
}

/** The fingerprint of the profile currently stored. */
export function currentFingerprint(db: Database): string {
  // The column is `skill`, not `slug`.
  const rows = db
    .query<FingerprintInput, []>(`SELECT skill AS slug, level FROM profile_skills`)
    .all();
  return fingerprintOf(rows);
}

export interface Freshness {
  /** Rankings computed against the profile as it stands. */
  current: number;
  /** Rankings computed against some earlier profile. */
  stale: number;
  /** Rankings from before fingerprints were recorded at all. */
  unknown: number;
}

/**
 * How much of the ranking still reflects the current profile.
 *
 * Rows written before this column existed are reported as `unknown` rather than
 * assumed current: they may well be stale, and claiming otherwise would repeat
 * the original mistake.
 */
export function rankingFreshness(db: Database, fingerprint?: string): Freshness {
  const now = fingerprint ?? currentFingerprint(db);
  const row = db
    .query<{ current: number; stale: number; unknown: number }, [string]>(
      `SELECT
         SUM(CASE WHEN profile_fingerprint = ?  THEN 1 ELSE 0 END) AS current,
         SUM(CASE WHEN profile_fingerprint IS NOT NULL
                   AND profile_fingerprint <> ?1 THEN 1 ELSE 0 END) AS stale,
         SUM(CASE WHEN profile_fingerprint IS NULL THEN 1 ELSE 0 END) AS unknown
       FROM matches`,
    )
    .get(now);
  return {
    current: row?.current ?? 0,
    stale: row?.stale ?? 0,
    unknown: row?.unknown ?? 0,
  };
}
