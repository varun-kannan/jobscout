/**
 * The shapes AI answers must satisfy.
 *
 * Every field is constrained as tightly as the domain allows — enums rather
 * than strings, bounded integers rather than numbers — because a schema is the
 * only thing standing between a model's output and the database.
 */

import { z } from "zod";

/* ── normalise ────────────────────────────────────────────────────── */

export const normaliseSchema = z.object({
  seniority: z
    .enum(["intern", "junior", "mid", "senior", "staff", "principal", "lead", "unknown"])
    .describe("Seniority the posting expects"),
  yearsRequired: z
    .number()
    .int()
    .min(0)
    .max(40)
    .nullable()
    .describe("Years of experience required, null if unstated"),
  employmentType: z
    .enum(["full-time", "part-time", "contract", "internship", "unknown"])
    .describe("Employment type"),
  /**
   * The trap this exists to catch: postings titled "Remote" that restrict
   * hiring to one country somewhere in the body.
   */
  remote: z.enum(["remote", "remote-restricted", "hybrid", "onsite", "unknown"]),
  remoteRestriction: z
    .string()
    .max(120)
    .nullable()
    .describe("Where a remote role is restricted to, e.g. 'US only'. Null if unrestricted."),
  salaryMin: z.number().nonnegative().nullable(),
  salaryMax: z.number().nonnegative().nullable(),
  salaryCurrency: z.string().max(8).nullable(),
  salaryPeriod: z.enum(["annual", "monthly", "hourly"]).nullable(),
});

export type Normalised = z.infer<typeof normaliseSchema>;

/* ── skills ───────────────────────────────────────────────────────── */

export const jobSkillsSchema = z.object({
  required: z
    .array(z.string().min(1).max(60))
    .max(40)
    .describe("Skills the role genuinely requires"),
  preferred: z
    .array(z.string().min(1).max(60))
    .max(40)
    .describe("Skills described as nice to have, bonus, or preferred"),
});

export type ExtractedJobSkills = z.infer<typeof jobSkillsSchema>;

/* ── score ────────────────────────────────────────────────────────── */

export const scoreSchema = z.object({
  score: z.number().int().min(1).max(5).describe("1 poor fit, 5 excellent fit"),
  reason: z.string().min(1).max(300).describe("One sentence, specific to this posting"),
  concerns: z
    .array(z.string().max(160))
    .max(6)
    .describe("Concrete reservations: seniority mismatch, red flags, scope drift"),
  /**
   * Asked for explicitly because skill overlap cannot see it. A sales role at a
   * payments company matches a payments engineer's skills almost perfectly.
   */
  roleTypeMatch: z
    .enum(["same", "adjacent", "different"])
    .describe("Is this the same kind of work the candidate does?"),
});

export type AiScore = z.infer<typeof scoreSchema>;

/* ── signals ──────────────────────────────────────────────────────── */

export const signalsSchema = z.object({
  wlbScore: z.number().int().min(1).max(5).describe("1 poor, 5 good, judged only from the text"),
  /** Every judgement must cite the line that supports it. */
  evidence: z
    .array(
      z.object({
        quote: z.string().max(200).describe("Verbatim from the posting"),
        polarity: z.enum(["positive", "negative"]),
        note: z.string().max(120),
      }),
    )
    .max(8),
  redFlags: z.array(z.string().max(140)).max(6),
  greenFlags: z.array(z.string().max(140)).max(6),
  interviewStages: z.number().int().min(0).max(12).nullable(),
});

export type AiSignals = z.infer<typeof signalsSchema>;

/* ── dedupe ───────────────────────────────────────────────────────── */

export const dedupeSchema = z.object({
  groups: z
    .array(
      z.object({
        canonical: z.string().describe("id of the posting to keep"),
        duplicates: z.array(z.string()).describe("ids that are the same role"),
      }),
    )
    .max(60),
});

export type DedupeResult = z.infer<typeof dedupeSchema>;

/* ── draft ────────────────────────────────────────────────────────── */

export const draftSchema = z.object({
  coverLetter: z.string().min(80).describe("Complete letter, ready to paste"),
  resumeNotes: z
    .array(z.string().max(240))
    .max(8)
    .describe("Which existing bullets to emphasise for this role"),
  answers: z
    .array(z.object({ question: z.string().max(300), answer: z.string().max(1500) }))
    .max(10)
    .describe("Answers to screening questions visible in the posting"),
  /** Surfaced rather than invented — a guessed personal detail is worse than a gap. */
  missingInformation: z
    .array(z.string().max(200))
    .max(6)
    .describe("Anything the posting asks for that the profile does not contain"),
});

export type Draft = z.infer<typeof draftSchema>;
