/**
 * What kind of company is advertising.
 *
 * A product company and a staffing agency post the same titles and are not the
 * same job: one is the employer, the other is placing you somewhere it will not
 * name. Filtering on that is the difference between a shortlist and a list.
 *
 * Classification is deterministic wherever the evidence is plain, because the
 * cues are strong and arithmetic is free — an agency posting almost always says
 * "our client", and a consultancy usually says so in its own name. Only what
 * the rules cannot settle is worth asking a model about.
 */

export type CompanyType =
  | "product"
  | "service"
  | "consultancy"
  | "staffing"
  | "agency"
  | "nonprofit"
  | "unknown";

export const COMPANY_TYPES: readonly CompanyType[] = [
  "product", "service", "consultancy", "staffing", "agency", "nonprofit", "unknown",
];

/**
 * Phrases that give the game away, strongest first.
 *
 * Order matters: a staffing firm often calls itself a consultancy, so the
 * placement language is checked before the name.
 */
const DESCRIPTION_CUES: Array<{ type: CompanyType; patterns: RegExp[] }> = [
  {
    type: "staffing",
    patterns: [
      /\bour client\b/i,
      /\bon behalf of (?:our|a) client\b/i,
      /\bclient(?:'s)? (?:site|location|premises)\b/i,
      /\bcontract(?:-| )to(?:-| )hire\b/i,
      /\bC2H\b/,
      /\b(?:W2|corp[- ]to[- ]corp|C2C)\b/i,
      /\bplacement\b.{0,40}\bcandidate/i,
      /\bstaffing (?:firm|agency|solutions)\b/i,
      /\bdeputed?\b/i,
    ],
  },
  {
    type: "agency",
    patterns: [
      /\brecruit(?:ment|ing) (?:agency|partner|firm)\b/i,
      /\bwe are (?:a|an) (?:recruitment|search) (?:firm|agency)\b/i,
      /\bheadhunt/i,
      /\btalent acquisition partner for\b/i,
    ],
  },
  {
    type: "nonprofit",
    patterns: [
      /\bnon[- ]?profit\b/i,
      /\bNGO\b/,
      /\bcharit(?:y|able)\b/i,
      /\b501\(c\)\(3\)\b/,
      /\bfoundation\b.{0,30}\bmission\b/i,
    ],
  },
  {
    type: "consultancy",
    patterns: [
      /\bconsult(?:ing|ancy) (?:firm|services|practice)\b/i,
      /\bour consultants\b/i,
      /\bclient engagements?\b/i,
      /\bbillable\b/i,
    ],
  },
  {
    type: "service",
    patterns: [
      /\bIT services\b/i,
      /\bsystems? integrat(?:or|ion)\b/i,
      /\bmanaged services\b/i,
      /\boutsourc/i,
      /\bdelivery cent(?:re|er)\b/i,
    ],
  },
  {
    type: "product",
    patterns: [
      /\bour (?:product|platform|app)\b/i,
      /\bour (?:customers|users) (?:use|rely)/i,
      /\bproduct[- ]led\b/i,
      /\bship(?:ping)? (?:features|product)\b/i,
      /\bSaaS\b/,
    ],
  },
];

/** Name endings that are strong on their own. */
const NAME_CUES: Array<{ type: CompanyType; pattern: RegExp }> = [
  { type: "staffing", pattern: /\b(?:staffing|manpower|resourcing|placements?|hr\s*services)\b/i },
  { type: "agency", pattern: /\b(?:recruit(?:ment|ers?)|talent\s*(?:solutions|partners))\b/i },
  { type: "consultancy", pattern: /\b(?:consult(?:ing|ancy|ants)|advisory)\b/i },
  { type: "service", pattern: /\b(?:it\s*services|infotech|technologies|solutions|softech|systems)\b/i },
  { type: "nonprofit", pattern: /\b(?:foundation|trust|society|charity)\b/i },
];

export interface Classification {
  type: CompanyType;
  /** Why, in a few words — so a wrong answer can be argued with. */
  reason: string;
  /** True when a model should be asked instead. */
  uncertain: boolean;
}

/**
 * Classify from the company name and posting text alone.
 *
 * Returns `unknown` with `uncertain` set when nothing decisive appears, rather
 * than guessing "product" because that is the commonest answer.
 */
export function classifyCompany(company: string, description = ""): Classification {
  const text = description.slice(0, 6000);

  for (const { type, patterns } of DESCRIPTION_CUES) {
    const hit = patterns.find((p) => p.test(text));
    if (hit) {
      return { type, reason: `posting says ${describe(hit)}`, uncertain: false };
    }
  }

  for (const { type, pattern } of NAME_CUES) {
    if (pattern.test(company)) {
      // A name is weaker evidence than what the posting says: plenty of product
      // companies are called "… Technologies".
      return { type, reason: `name suggests ${type}`, uncertain: type === "service" };
    }
  }

  return { type: "unknown", reason: "nothing decisive in the name or text", uncertain: true };
}

/** A readable fragment of the pattern that matched. */
function describe(pattern: RegExp): string {
  return pattern.source
    .replace(/\\b|\(\?:|\)|\?|\\/g, "")
    .replace(/\|/g, " or ")
    .replace(/\.\{0,\d+\}/g, " … ")
    .trim();
}
