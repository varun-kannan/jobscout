/**
 * The config schema. Anything crossing the disk boundary is parsed, not trusted.
 *
 * config.toml holds preferences and is safe to share or commit.
 * secrets.toml holds credentials, lives at mode 600, and is never shared.
 */

import { z } from "zod";

export const ENGINE_IDS = [
  // Family A — applicant tracking systems, keyless
  "greenhouse",
  "lever",
  "ashby",
  "recruitee",
  "workable",
  "smartrecruiters",
  // Family B — job boards, keyless
  "remoteok",
  "arbeitnow",
  "themuse",
  "remotive",
  "himalayas",
  "jobicy",
  "hackernews",
  // Family C — India, keyless
  "foundit",
  "instahyre",
  // Family D — keyed aggregators
  "adzuna",
  "careerjet",
  "jooble",
  // Family E — scraper, opt-in
  "jobspy",
] as const;

export type EngineId = (typeof ENGINE_IDS)[number];

/** Engines needing no credential and no runtime — on by default. */
export const KEYLESS_ENGINES: readonly EngineId[] = [
  "greenhouse",
  "lever",
  "ashby",
  "recruitee",
  "workable",
  "smartrecruiters",
  "remoteok",
  "arbeitnow",
  "themuse",
  "remotive",
  "himalayas",
  "jobicy",
  "hackernews",
  "foundit",
  "instahyre",
];

export const SKILL_LEVELS = ["exposure", "working", "strong", "expert"] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];

export const AI_PROVIDERS = [
  // Free with a subscription — the default, and the reason there is no key to manage.
  "claude-code",
  // Free and local. No key, no spend, nothing leaves the machine.
  "ollama",
  // Paid APIs. Opt-in only.
  "anthropic",
  "openai",
  "gemini",
  // Other agent CLIs, reusing a subscription you already have.
  "gemini-cli",
  "codex-cli",
  "none",
] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** Providers that cost money, and so must never be enabled by default. */
export const PAID_PROVIDERS: readonly AiProvider[] = ["anthropic", "openai", "gemini"];

/**
 * The pipeline's AI work, by what it demands of a model.
 *
 * Tiering by task rather than by budget saves money on every run: `extract`
 * runs ~120 times per discovery and is structured extraction a small model
 * handles well, while `draft` runs a handful of times and is the one place
 * writing quality is the entire point.
 */
export const AI_TIERS = ["extract", "judge", "write"] as const;
export type AiTier = (typeof AI_TIERS)[number];

const profileSchema = z.strictObject({
  resumeFile: z.string().min(1).optional(),
  fullName: z.string().default(""),
  email: z.string().default(""),
  phone: z.string().default(""),
  location: z.string().default(""),
  linkedin: z.string().default(""),
  portfolio: z.string().default(""),
  workAuthorization: z.string().default(""),
  requiresSponsorship: z.boolean().default(false),
  noticePeriod: z.string().default(""),
});

const searchSchema = z.strictObject({
  roles: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
  remoteOnly: z.boolean().default(false),
  salaryCurrency: z.string().default("USD"),
  salaryMin: z.number().nonnegative().nullable().default(null),
  salaryMax: z.number().nonnegative().nullable().default(null),
  salaryPeriod: z.enum(["annual", "monthly", "hourly"]).default("annual"),
});

/**
 * Match weights. They must sum to 1.0 — a config where they do not is a config
 * whose scores cannot be compared against anyone else's, so it is rejected.
 */
const matchSchema = z
  .object({
    requiredCoverage: z.number().min(0).max(1).default(0.6),
    preferredCoverage: z.number().min(0).max(1).default(0.2),
    seniorityFit: z.number().min(0).max(1).default(0.15),
    domainAffinity: z.number().min(0).max(1).default(0.05),
    threshold: z.number().min(0).max(1).default(0.5),
  })
  .refine(
    (w) => {
      const sum = w.requiredCoverage + w.preferredCoverage + w.seniorityFit + w.domainAffinity;
      return Math.abs(sum - 1) < 1e-6;
    },
    { message: "match weights must sum to 1.0 (threshold is separate)" },
  );

const tierSchema = z.strictObject({
  provider: z.enum(AI_PROVIDERS),
  model: z.string(),
});

const budgetSchema = z.strictObject({
  /** USD. Zero means no limit. */
  limit: z.number().nonnegative().default(0),
  period: z.enum(["weekly", "monthly", "none"]).default("monthly"),
});

const aiSchema = z.strictObject({
  /**
   * Tried in order until one is available, so a missing CLI or an unset key
   * falls through rather than failing the run.
   */
  providers: z
    .array(z.enum(AI_PROVIDERS))
    // Agent CLIs first: each spends a subscription you already hold rather
    // than charging per call, so the default costs nothing. Ollama follows as
    // the free local option. No paid provider is ever in the default.
    .default(["claude-code", "codex-cli", "gemini-cli", "ollama"]),
  model: z.string().default("claude-sonnet-5"),
  /** Per-task overrides. Anything unset uses `providers` and `model`. */
  tiers: z
    .object({
      extract: tierSchema.optional(),
      judge: tierSchema.optional(),
      write: tierSchema.optional(),
    })
    .prefault({}),
  budget: budgetSchema.prefault({}),
});

const enginesSchema = z.strictObject({
  enabled: z.array(z.enum(ENGINE_IDS)).default([...KEYLESS_ENGINES]),
});

export const configSchema = z.strictObject({
  version: z.number().int().default(1),
  profile: profileSchema.prefault({}),
  search: searchSchema.prefault({}),
  engines: enginesSchema.prefault({}),
  match: matchSchema.prefault({}),
  ai: aiSchema.prefault({}),
});

export type Config = z.infer<typeof configSchema>;

export const secretsSchema = z.object({
  adzuna: z.object({ appId: z.string(), appKey: z.string() }).optional(),
  careerjet: z.object({ affid: z.string() }).optional(),
  jooble: z.object({ key: z.string(), domain: z.string().default("jooble.org") }).optional(),
  anthropic: z.object({ apiKey: z.string() }).optional(),
  openai: z.object({ apiKey: z.string() }).optional(),
  gemini: z.object({ apiKey: z.string() }).optional(),
});

export type Secrets = z.infer<typeof secretsSchema>;

/** A config with every default applied — what `init` writes on a fresh install. */
export function defaultConfig(): Config {
  return configSchema.parse({});
}

/** Engines that cannot run until something in secrets.toml or the system exists. */
export function engineRequirement(id: EngineId): string | null {
  switch (id) {
    case "adzuna":
      return "an Adzuna app ID and key";
    case "careerjet":
      return "a Careerjet affiliate ID";
    case "jooble":
      return "a Jooble API key for your country's domain";
    case "jobspy":
      return "Python 3.10 or newer";
    default:
      return null;
  }
}
