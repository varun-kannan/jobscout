/**
 * Finding skills in free text, without a model.
 *
 * This is the deterministic extractor. It scans for known vocabulary and, for
 * job descriptions, works out whether each hit is required or merely preferred
 * from the surrounding wording.
 *
 * It is honest about its ceiling: it recognises what it has seen before and
 * misses paraphrase — "experience with event streaming platforms" only resolves
 * to Kafka because that exact phrase is an alias, and no keyword list catches
 * every rewording. The AI extractor in phase 4 layers over this; this path is
 * what keeps matching working in no-AI mode, and what handles sources like
 * Foundit that hand over skills already structured.
 */

import { AMBIGUOUS_SLUGS, CANONICAL_SKILLS, type SkillCategory, categoryOf, labelOf } from "./canonical.ts";
import { AliasResolver, normaliseSkillText } from "./aliases.ts";

export type Requirement = "required" | "preferred";

export interface ExtractedSkill {
  slug: string;
  label: string;
  category: SkillCategory;
  requirement: Requirement;
  /** The phrase that produced the match, for showing your working. */
  evidence?: string;
}

/**
 * Every spelling worth scanning for, longest first.
 *
 * Longest-first matters: without it "spring" matches inside "spring boot" and
 * the more specific skill is lost.
 */
const SEARCH_TERMS: ReadonlyArray<{ term: string; slug: string }> = (() => {
  const terms: Array<{ term: string; slug: string }> = [];
  for (const skill of CANONICAL_SKILLS) {
    const spellings = new Set([skill.label.toLowerCase(), ...(skill.aliases ?? [])]);
    // Slugs with separators ("spring-boot") are not how people write prose.
    if (!skill.slug.includes("-")) spellings.add(skill.slug);
    for (const term of spellings) terms.push({ term: normaliseSkillText(term), slug: skill.slug });
  }
  return terms.filter((t) => t.term.length >= 2).sort((a, b) => b.term.length - a.term.length);
})();

/** Escape a spelling for use inside a regular expression. */
function escape(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does an ambiguous name look like a skill here, or like ordinary English?
 *
 * Accepted when the mention sits in a list of skills ("Java, Go, Python",
 * "Go/Rust") or follows a phrase that introduces one ("experience with Go",
 * "written in Go"). Rejected otherwise — which is what stops "Go beyond code"
 * and "go to market" from registering as the language.
 *
 * An unambiguous alias — "golang" — never reaches this check.
 *
 * Runs against the original text rather than the normalised haystack, because
 * normalisation strips the commas and slashes that mark a list — checking the
 * stripped form rejected "Java, Go, Python" as ordinary prose.
 */
/**
 * Words that only ever follow the verb, never the technology.
 *
 * This is the sharpest signal available: "Go beyond code", "go-live dates",
 * "go to market". Checking what *follows* the word catches cases that looking
 * at what precedes it cannot — "operational readiness: Go beyond code" has a
 * colon in front of it and still is not the language.
 */
const VERB_CONTINUATIONS = [
  "beyond", "through", "to", "into", "above", "live", "back", "ahead",
  "forward", "out", "up", "down", "over", "past", "along", "well", "the",
  "extra", "wrong", "right", "public", "deep", "hand", "unnoticed",
];

function hasSkillContext(original: string, term: string): boolean {
  const t = escape(term);

  // Rejected outright, whatever else the sentence looks like.
  const asVerb = new RegExp(`\\b${t}[\\s-]+(?:${VERB_CONTINUATIONS.join("|")})\\b`, "i");
  if (asVerb.test(original)) return false;

  // In a delimited list, or introduced by a colon. Job postings write
  // "Requirements: Go" and "Tech stack: Go/Rust" constantly, and a colon
  // introduces a technology just as clearly as a comma separates one.
  const inList = new RegExp(`(?:[,/|•·:]\\s*${t}\\b)|(?:\\b${t}\\s*[,/|])`, "i");
  if (inList.test(original)) return true;

  // Directly introduced: the cue must sit immediately before the term.
  // Allowing a gap here was far too loose — with 24 characters of slack, the
  // preposition "in" fired on "participate in projects defining go-to-market"
  // and credited a sales posting with the Go language.
  const adjacent = new RegExp(
    `\\b(?:in|with|using|know|knows|written|write|writing|learn)\\s+(?:the\\s+)?${t}\\b`,
    "i",
  );
  if (adjacent.test(original)) return true;

  // A strong cue may sit a little further off, because these words introduce a
  // technology and almost nothing else: "proficiency in Go", "expertise in Go".
  const strongCue = new RegExp(
    `\\b(?:experience|proficien\\w*|fluent|expertise|skilled|familiar\\w*|hands-on)\\b[^.!?\\n]{0,18}\\b${t}\\b`,
    "i",
  );
  if (strongCue.test(original)) return true;

  // Followed by a word that only follows a technology. "Dart experience" and
  // "Go expertise" name a skill just as plainly as "Go developer" does.
  const qualified = new RegExp(
    `\\b${t}\\s+(?:developer|engineer|programming|language|codebase|services?|microservices?|backend|lang|experience|expertise|skills?|knowledge|background|development)\\b`,
    "i",
  );
  return qualified.test(original);
}

/**
 * Word-boundary match that tolerates the symbols in technology names.
 *
 * `\b` does not work after "c++" or "c#", because `+` and `#` are not word
 * characters — so the boundary is expressed with lookarounds instead.
 */
function matchesTerm(haystack: string, term: string): boolean {
  const pattern = new RegExp(`(?<![a-z0-9])${escape(term)}(?![a-z0-9])`, "i");
  return pattern.test(haystack);
}

/** Sentences that mark what follows as non-negotiable. */
const REQUIRED_CUES = [
  "required",
  "requirements",
  "must have",
  "must-have",
  "you have",
  "you will need",
  "essential",
  "minimum qualifications",
  "what you bring",
  "qualifications",
  "we require",
  "proficiency in",
  "strong experience",
  "expert in",
];

/** Sentences that mark what follows as optional. */
const PREFERRED_CUES = [
  "nice to have",
  "nice-to-have",
  "preferred",
  "bonus",
  "plus",
  "a plus",
  "desirable",
  "advantageous",
  "would be great",
  "ideally",
  "familiarity with",
  "exposure to",
];

/**
 * Decide required vs preferred from the section a mention sits in.
 *
 * Job descriptions are written as blocks — a "Nice to have" heading governs
 * everything under it until the next heading. So the nearest preceding cue
 * wins, rather than scanning the whole document for either word.
 */
function requirementAt(text: string, index: number): Requirement {
  const before = text.slice(Math.max(0, index - 600), index).toLowerCase();

  let nearestRequired = -1;
  let nearestPreferred = -1;
  for (const cue of REQUIRED_CUES) nearestRequired = Math.max(nearestRequired, before.lastIndexOf(cue));
  for (const cue of PREFERRED_CUES) nearestPreferred = Math.max(nearestPreferred, before.lastIndexOf(cue));

  if (nearestPreferred > nearestRequired) return "preferred";
  return "required";
}

export interface ExtractOptions {
  resolver?: AliasResolver;
  /** Skip the required/preferred split — résumés have no such distinction. */
  flat?: boolean;
}

/** Pull canonical skills out of a block of prose. */
export function extractSkills(text: string, options: ExtractOptions = {}): ExtractedSkill[] {
  if (!text) return [];
  const haystack = normaliseSkillText(text);
  if (!haystack) return [];
  // Kept alongside the normalised form: the ambiguity check needs the
  // punctuation that normalisation removes.
  const original = text.toLowerCase();

  const found = new Map<string, ExtractedSkill>();

  for (const { term, slug } of SEARCH_TERMS) {
    if (found.has(slug)) continue;
    if (!matchesTerm(haystack, term)) continue;

    // An ambiguous name matched by its own spelling needs supporting context;
    // matched by an unambiguous alias ("golang") it does not.
    if (AMBIGUOUS_SLUGS.has(slug) && term === slug && !hasSkillContext(original, term)) {
      continue;
    }

    const index = haystack.indexOf(term);
    found.set(slug, {
      slug,
      label: labelOf(slug),
      category: categoryOf(slug),
      requirement: options.flat ? "required" : requirementAt(haystack, index),
      evidence: term,
    });
  }

  return [...found.values()];
}

/**
 * Normalise a list a source already handed over — Foundit's skills, Instahyre's
 * keywords, RemoteOK's tags. No scanning involved, just resolution.
 */
export function normaliseSkillList(
  labels: readonly string[],
  options: ExtractOptions = {},
): ExtractedSkill[] {
  const resolver = options.resolver ?? new AliasResolver();
  const found = new Map<string, ExtractedSkill>();

  for (const raw of labels) {
    const slug = resolver.resolve(raw);
    if (!slug || found.has(slug)) continue;
    found.set(slug, {
      slug,
      label: labelOf(slug),
      category: categoryOf(slug),
      requirement: "required",
      evidence: raw,
    });
  }

  return [...found.values()];
}
