/**
 * Resolving a written skill to its canonical slug.
 *
 * This is the piece that stops a real match being missed on spelling. It works
 * off three layers, in order: the shipped vocabulary, aliases learned at
 * runtime (Foundit hands over a synonyms map for free), and a slugify fallback
 * so an unknown skill still gets a stable key rather than being discarded.
 */

import { ALIAS_TO_SLUG } from "./canonical.ts";

/** Lowercase, collapse separators, strip decoration. */
export function normaliseSkillText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[（(\[{].*?[）)\]}]/g, " ") // drop parenthetical asides
    .replace(/[^a-z0-9+#./\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A stable key for a skill the vocabulary has never seen.
 *
 * Preserves `+` and `#` so "c++" and "c#" do not collapse into "c".
 */
export function slugifySkill(text: string): string {
  return normaliseSkillText(text)
    .replace(/[./\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export class AliasResolver {
  /** Runtime aliases, layered over the shipped vocabulary. */
  private readonly learned = new Map<string, string>();

  constructor(learned: Iterable<[string, string]> = []) {
    for (const [alias, canonical] of learned) {
      this.learned.set(normaliseSkillText(alias), canonical);
    }
  }

  /** Resolve one written skill to a canonical slug. */
  resolve(text: string): string | null {
    const normalised = normaliseSkillText(text);
    if (!normalised) return null;

    // The vocabulary is consulted before any length rule, because several real
    // languages are a single letter — C and R among them. Rejecting short
    // strings first made both unresolvable.
    const known = ALIAS_TO_SLUG.get(normalised) ?? this.learned.get(normalised);
    if (known) return known;

    // Only now is brevity evidence of noise: an unrecognised single character
    // is punctuation or a list artefact, not a skill.
    if (normalised.length < 2) return null;

    const slug = slugifySkill(normalised);
    if (!slug) return null;
    // The slug itself may be a known spelling: "spring-boot" → "spring-boot".
    return ALIAS_TO_SLUG.get(slug) ?? this.learned.get(slug) ?? slug;
  }

  /**
   * Teach a new spelling.
   *
   * Never overwrites a shipped alias — a source claiming "java" means something
   * other than Java should not be able to redefine the vocabulary.
   */
  learn(alias: string, canonical: string): boolean {
    const key = normaliseSkillText(alias);
    if (!key || ALIAS_TO_SLUG.has(key) || this.learned.has(key)) return false;
    this.learned.set(key, canonical);
    return true;
  }

  /** Aliases learned this session, for persisting to skill_aliases. */
  learnedEntries(): Array<[string, string]> {
    return [...this.learned.entries()];
  }

  get size(): number {
    return this.learned.size;
  }
}
