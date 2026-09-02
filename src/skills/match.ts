/**
 * The ranker.
 *
 * Deliberately not AI. Once the skills on both sides are known, deciding how
 * well you fit a role is set intersection — count what matched, count what did
 * not, divide. That makes the ordering of the job list reproducible, auditable,
 * and free, so every posting gets measured rather than sampled.
 *
 * Pure functions only: no I/O, no database, no network, no clock. Everything
 * here is a value in, a value out — which is what makes the ranking testable
 * and identical on every run.
 */

import type { SkillCategory } from "./canonical.ts";
import { categoryOf, labelOf } from "./canonical.ts";

export const SKILL_LEVELS = ["exposure", "working", "strong", "expert"] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];

/** One skill you hold. */
export interface ProfileSkill {
  slug: string;
  label: string;
  category: SkillCategory;
  level: SkillLevel;
  years?: number;
}

/** One skill a posting asks for. */
export interface JobSkill {
  slug: string;
  label: string;
  requirement: "required" | "preferred";
}

export interface MatchWeights {
  requiredCoverage: number;
  preferredCoverage: number;
  seniorityFit: number;
  domainAffinity: number;
}

export interface MatchInput {
  profile: readonly ProfileSkill[];
  job: readonly JobSkill[];
  weights: MatchWeights;
  /** Your level and the role's, when both are known. */
  seniority?: { yours?: number; theirs?: number };
  /** Domains you work in, e.g. ["payments", "fintech"]. */
  domains?: readonly string[];
}

export interface MatchResult {
  matchedRequired: number;
  totalRequired: number;
  matchedPreferred: number;
  totalPreferred: number;
  /** Plain proportion of required skills matched, unweighted. */
  coverage: number;
  /** The composite the list is sorted by. */
  matchScore: number;
  matched: string[];
  missing: string[];
  /** Strengths the posting did not ask for — useful in a cover letter. */
  bonus: string[];
  /** How each component contributed, so the score can show its working. */
  components: {
    weightedRequired: number;
    preferred: number;
    seniority: number;
    domain: number;
  };
}

/**
 * How much a held skill counts towards a requirement.
 *
 * A required skill held at expert should contribute more than the same skill at
 * exposure, so coverage is weighted rather than a plain count. The floor is
 * deliberately well above zero: having touched something is much closer to
 * knowing it than to never having seen it.
 */
const LEVEL_WEIGHT: Record<SkillLevel, number> = {
  exposure: 0.55,
  working: 0.8,
  strong: 1.0,
  expert: 1.0,
};

/**
 * How much *missing* a requirement costs.
 *
 * Missing a skill you have never touched is a real gap. Missing one adjacent to
 * something you do hold is less serious, but the extractor cannot see adjacency,
 * so every miss currently costs the same. Kept as a named constant so the
 * intent survives when adjacency arrives.
 */
const MISS_WEIGHT = 1.0;

/**
 * Smoothing that stops a thin posting outscoring a thorough one.
 *
 * A plain ratio treats 1-of-1 as a perfect fit, so postings that happen to
 * name a single requirement float to the top of the list. Ranking a real run
 * produced exactly that: "Legal Entity Controller" and "Account Executive"
 * scored 100% on one matched skill, above a backend role matching nine of
 * eleven.
 *
 * Adding pseudo-requirements pulls a short list towards zero and lets a long
 * one approach its true ratio, so the score reflects both *how well* you match
 * and *how much was asked*:
 *
 *     1 of 1   → 0.33      3 of 3   → 0.60
 *     9 of 11  → 0.69     11 of 11  → 0.85
 *
 * The effect is strongest where evidence is thinnest, which is where it should
 * be. It is not a penalty for short postings; it is a refusal to be confident
 * about them.
 */
const EVIDENCE_SMOOTHING = 2;

export const DEFAULT_WEIGHTS: MatchWeights = {
  requiredCoverage: 0.6,
  preferredCoverage: 0.2,
  seniorityFit: 0.15,
  domainAffinity: 0.05,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Seniority agreement, from years of experience on each side.
 *
 * Returns 1 when the role's expectation sits at or below yours, and falls away
 * as the gap widens. Being *over*-qualified is only mildly penalised: it is a
 * weaker signal than being under-qualified, and often not a problem at all.
 */
function seniorityFit(yours?: number, theirs?: number): number {
  if (yours == null || theirs == null) return 0.5; // no information, not a verdict
  if (theirs <= yours) {
    const over = yours - theirs;
    return over <= 3 ? 1 : clamp01(1 - (over - 3) / 10);
  }
  const short = theirs - yours;
  return clamp01(1 - short / 5);
}

/** Proportion of the role's skills that fall in a domain you work in. */
function domainAffinity(job: readonly JobSkill[], domains: readonly string[]): number {
  if (domains.length === 0) return 0.5;
  const wanted = new Set(domains.map((d) => d.toLowerCase()));
  const jobDomains = job.filter((s) => categoryOf(s.slug) === "domain");
  if (jobDomains.length === 0) return 0.5;
  const hits = jobDomains.filter((s) => wanted.has(s.slug)).length;
  return clamp01(hits / jobDomains.length);
}

/**
 * Score one posting against one profile.
 *
 * A posting listing no requirements scores 0 rather than 1: an empty
 * intersection is an absence of evidence, and treating it as a perfect match
 * would float every skill-less posting to the top of the list.
 */
export function matchJob(input: MatchInput): MatchResult {
  const held = new Map(input.profile.map((s) => [s.slug, s]));

  const required = input.job.filter((s) => s.requirement === "required");
  const preferred = input.job.filter((s) => s.requirement === "preferred");

  const matched: string[] = [];
  const missing: string[] = [];

  let earned = 0;
  let possible = 0;
  let matchedRequired = 0;

  for (const skill of required) {
    const mine = held.get(skill.slug);
    if (mine) {
      earned += LEVEL_WEIGHT[mine.level];
      possible += 1;
      matchedRequired++;
      matched.push(skill.slug);
    } else {
      possible += MISS_WEIGHT;
      missing.push(skill.slug);
    }
  }

  let matchedPreferred = 0;
  for (const skill of preferred) {
    if (held.has(skill.slug)) {
      matchedPreferred++;
      matched.push(skill.slug);
    } else {
      missing.push(skill.slug);
    }
  }

  const asked = new Set(input.job.map((s) => s.slug));
  const bonus = input.profile
    .filter((s) => !asked.has(s.slug) && (s.level === "strong" || s.level === "expert"))
    .map((s) => s.slug);

  // Both coverages are smoothed, and for the same reason. Smoothing only the
  // required side made one matched requirement worth exactly as much as one
  // matched preference, because the unsmoothed ratio scored a full 1.0 while
  // the smoothed one could not. Thin evidence is thin on either side.
  const weightedRequired =
    possible > 0 ? clamp01(earned / (possible + EVIDENCE_SMOOTHING)) : 0;
  const preferredCoverage =
    preferred.length > 0
      ? clamp01(matchedPreferred / (preferred.length + EVIDENCE_SMOOTHING))
      : 0.5; // nothing asked for is not a failure to meet it
  const seniority = seniorityFit(input.seniority?.yours, input.seniority?.theirs);
  const domain = domainAffinity(input.job, input.domains ?? []);

  const w = input.weights;
  const matchScore =
    input.job.length === 0
      ? 0
      : clamp01(
          w.requiredCoverage * weightedRequired +
            w.preferredCoverage * preferredCoverage +
            w.seniorityFit * seniority +
            w.domainAffinity * domain,
        );

  return {
    matchedRequired,
    totalRequired: required.length,
    matchedPreferred,
    totalPreferred: preferred.length,
    // The plain, unweighted proportion — what the review screen shows as
    // "9/11". `components.weightedRequired` is the depth-weighted version the
    // score actually uses; keeping both means the display never has to explain
    // why 9 of 11 did not read as 82%.
    coverage: required.length > 0 ? matchedRequired / required.length : 0,
    matchScore,
    matched,
    missing,
    bonus,
    components: { weightedRequired, preferred: preferredCoverage, seniority, domain },
  };
}

/** One line explaining a score, for the review screen. */
export function explainMatch(result: MatchResult): string {
  if (result.totalRequired === 0) return "no requirements listed";
  const pct = Math.round(result.coverage * 100);
  const parts = [`${result.matchedRequired}/${result.totalRequired} required (${pct}%)`];
  if (result.totalPreferred > 0) {
    parts.push(`${result.matchedPreferred}/${result.totalPreferred} preferred`);
  }
  return parts.join(" · ");
}

/** Display labels for a slug list, for the detail pane. */
export function labelsFor(slugs: readonly string[]): string[] {
  return slugs.map((s) => labelOf(s));
}
