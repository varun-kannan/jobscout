/**
 * Your skill graph: building it, storing it, and keeping your edits.
 *
 * Résumés understate things. A skill you used for four years but mentioned once
 * comes out looking weak, so the profile is editable — and an edit must survive
 * the next re-extraction, or correcting it would be pointless. That is what
 * `pinned` is for.
 */

import type { Database } from "bun:sqlite";
import type { SkillCategory } from "./canonical.ts";
import { categoryOf, labelOf, spellingsOf } from "./canonical.ts";
import { extractSkills } from "./extract.ts";
import { AliasResolver } from "./aliases.ts";
import type { ProfileSkill, SkillLevel } from "./match.ts";

export interface StoredSkill extends ProfileSkill {
  evidence: string | null;
  source: string;
  pinned: boolean;
}

interface SkillRow {
  skill: string;
  label: string;
  category: string;
  years: number | null;
  level: string;
  evidence: string | null;
  source: string;
  pinned: number;
}

function toProfileSkill(row: SkillRow): StoredSkill {
  return {
    slug: row.skill,
    label: row.label,
    category: row.category as SkillCategory,
    level: row.level as SkillLevel,
    years: row.years ?? undefined,
    evidence: row.evidence,
    source: row.source,
    pinned: row.pinned === 1,
  };
}

export function loadProfile(db: Database): StoredSkill[] {
  return db
    .query<SkillRow, []>(
      `SELECT skill, label, category, years, level, evidence, source, pinned
       FROM profile_skills ORDER BY category, skill`,
    )
    .all()
    .map(toProfileSkill);
}

/**
 * How strongly a résumé implies a skill.
 *
 * Mentions are a crude proxy, but an honest one: something named once in a
 * skills list is weaker evidence than something described repeatedly across
 * roles. Everything starts no higher than `strong` — claiming expertise on
 * your behalf is not the tool's place, and `jobscout skills --set` exists for
 * exactly that correction.
 */
export function levelFromMentions(mentions: number): SkillLevel {
  if (mentions >= 4) return "strong";
  if (mentions >= 2) return "working";
  return "exposure";
}

function occurrences(text: string, term: string): number {
  if (!term) return 0;
  const pattern = new RegExp(`(?<![a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "gi");
  return (text.match(pattern) ?? []).length;
}

/**
 * How often a skill is described, across every spelling of it.
 *
 * Counting only the phrase that happened to match under-reads badly: the
 * extractor scans longest-alias-first, so a résumé saying "payment systems"
 * once and "payments" three times matches on the former and counts 1.
 */
function countMentions(text: string, slug: string): number {
  return spellingsOf(slug).reduce((total, term) => total + occurrences(text, term), 0);
}

/** The résumé line a skill appeared on, so nothing is claimed without proof. */
function findEvidence(text: string, term: string): string | null {
  const lines = text.split("\n");
  const pattern = new RegExp(`(?<![a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i");
  // Prefer a descriptive line over a bare comma-separated skills list.
  const candidates = lines.filter((l) => pattern.test(l)).sort((a, b) => b.length - a.length);
  const best = candidates[0]?.trim();
  return best ? best.slice(0, 240) : null;
}

export interface BuildResult {
  added: number;
  updated: number;
  kept: number;
  skills: StoredSkill[];
}

/**
 * Build the graph from résumé text and persist it.
 *
 * Pinned rows are left completely alone — level, years, and evidence — because
 * a correction that a re-extraction can undo is not a correction.
 */
export function buildProfile(
  db: Database,
  text: string,
  options: { source?: string; extraText?: string } = {},
): BuildResult {
  const source = options.source ?? "resume";
  const corpus = [text, options.extraText ?? ""].filter(Boolean).join("\n");
  const resolver = new AliasResolver();
  const found = extractSkills(corpus, { resolver, flat: true });

  const pinned = new Set(
    db
      .query<{ skill: string }, []>(`SELECT skill FROM profile_skills WHERE pinned = 1`)
      .all()
      .map((r) => r.skill),
  );

  const existing = new Set(
    db.query<{ skill: string }, []>(`SELECT skill FROM profile_skills`).all().map((r) => r.skill),
  );

  const upsert = db.prepare(`
    INSERT INTO profile_skills (skill, label, category, years, level, evidence, source, pinned, updated_at)
    VALUES ($skill, $label, $category, NULL, $level, $evidence, $source, 0, $now)
    ON CONFLICT(skill) DO UPDATE SET
      label      = excluded.label,
      category   = excluded.category,
      level      = excluded.level,
      evidence   = excluded.evidence,
      source     = excluded.source,
      updated_at = excluded.updated_at
  `);

  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;
  let kept = 0;

  db.transaction(() => {
    for (const skill of found) {
      if (pinned.has(skill.slug)) {
        kept++;
        continue;
      }
      const mentions = countMentions(corpus, skill.slug);
      upsert.run({
        $skill: skill.slug,
        $label: labelOf(skill.slug),
        $category: categoryOf(skill.slug),
        $level: levelFromMentions(mentions),
        $evidence: findEvidence(corpus, skill.evidence ?? skill.slug),
        $source: source,
        $now: now,
      });
      if (existing.has(skill.slug)) updated++;
      else added++;
    }
  })();

  return { added, updated, kept, skills: loadProfile(db) };
}

/** Add or correct a skill by hand. Always pinned — you said it, it stays. */
export function setSkill(
  db: Database,
  input: { slug: string; level: SkillLevel; years?: number; label?: string },
): void {
  db.prepare(`
    INSERT INTO profile_skills (skill, label, category, years, level, evidence, source, pinned, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, 'manual', 1, ?)
    ON CONFLICT(skill) DO UPDATE SET
      label = excluded.label, category = excluded.category, years = excluded.years,
      level = excluded.level, source = 'manual', pinned = 1, updated_at = excluded.updated_at
  `).run(
    input.slug,
    input.label ?? labelOf(input.slug),
    categoryOf(input.slug),
    input.years ?? null,
    input.level,
    new Date().toISOString(),
  );
}

export function removeSkill(db: Database, slug: string): boolean {
  return db.prepare(`DELETE FROM profile_skills WHERE skill = ?`).run(slug).changes > 0;
}

/** Skills appearing most often in postings that you do not hold. */
export function skillGaps(db: Database, limit = 10): Array<{ slug: string; label: string; jobs: number }> {
  return db
    .query<{ slug: string; label: string; jobs: number }, [number]>(
      `SELECT js.skill AS slug, MIN(js.label) AS label, COUNT(DISTINCT js.job_id) AS jobs
       FROM job_skills js
       WHERE js.skill NOT IN (SELECT skill FROM profile_skills)
       GROUP BY js.skill
       ORDER BY jobs DESC
       LIMIT ?`,
    )
    .all(limit);
}
