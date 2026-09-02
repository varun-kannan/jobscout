/**
 * The Check contract.
 *
 * A check knows how to detect one condition and, where possible, repair it.
 * Because `init` is both first-run setup and later repair, every requirement is
 * expressed exactly once here and both paths get it automatically — there is no
 * way for "what setup installs" and "what repair verifies" to drift apart.
 *
 * A check never repairs anything on its own. It reports, and the runner asks.
 */

import type { Config, Secrets } from "../../config/schema.ts";
import type { Paths } from "../../config/paths.ts";
import type { DbHandle } from "../../db/db.ts";

export type CheckState =
  /** Requirement met. */
  | "ok"
  /** Requirement not met, and nothing works until it is. */
  | "fail"
  /** Requirement not met, but the tool still runs with reduced capability. */
  | "warn"
  /** Deliberately not configured — an optional engine left off, say. */
  | "skip";

export interface CheckResult {
  state: CheckState;
  /** One line, shown next to the check name. */
  summary: string;
  /** Optional extra lines explaining what is wrong and why it matters. */
  detail?: string[];
  /** Present when this check can offer to fix itself. */
  fix?: Fix;
}

export interface Fix {
  /** Shown as the prompt, e.g. "Create the data directory?" */
  label: string;
  /** Default answer when the user just presses enter. */
  defaultYes: boolean;
  /**
   * True when the fix cannot be performed by jobscout — it needs the user's
   * password, a browser, or a decision only they can make. The runner prints
   * `instructions` instead of calling `run`.
   */
  manual?: boolean;
  /** Shown for manual fixes: the exact commands or steps to follow. */
  instructions?: string[];
  run?(ctx: CheckContext): Promise<void>;
}

export interface CheckContext {
  paths: Paths;
  config: Config;
  secrets: Secrets;
  /** Null before the database exists — the database check creates it. */
  db: DbHandle | null;
  /** True when running with --yes; suppresses prompts and accepts defaults. */
  assumeYes: boolean;
  /** True when running with --dry-run; fixes are described, never executed. */
  dryRun: boolean;
  /** Lets a check hand an updated config back to the runner to persist. */
  setConfig(next: Config): void;
  setSecrets(next: Secrets): void;
  setDb(next: DbHandle): void;
}

export interface Check {
  id: string;
  /** Shown in the left column of the report. */
  title: string;
  /** Which phase of `init` this belongs to. */
  phase: Phase;
  /** Skip entirely when this returns false — e.g. Python only if JobSpy is on. */
  applies?(ctx: CheckContext): boolean;
  run(ctx: CheckContext): Promise<CheckResult>;
}

export const PHASES = [
  "environment",
  "dependencies",
  "profile",
  "engines",
  "boards",
  "verification",
] as const;

export type Phase = (typeof PHASES)[number];

export const PHASE_TITLES: Record<Phase, string> = {
  environment: "Environment",
  dependencies: "Dependencies",
  profile: "Your profile",
  engines: "Engines",
  boards: "Boards",
  verification: "Verification",
};

/* Small constructors so checks read as declarations rather than object literals. */

export function pass(summary: string, detail?: string[]): CheckResult {
  return detail ? { state: "ok", summary, detail } : { state: "ok", summary };
}

export function problem(summary: string, opts: { detail?: string[]; fix?: Fix } = {}): CheckResult {
  return { state: "fail", summary, ...opts };
}

export function caution(summary: string, opts: { detail?: string[]; fix?: Fix } = {}): CheckResult {
  return { state: "warn", summary, ...opts };
}

export function skipped(summary: string, detail?: string[]): CheckResult {
  return detail ? { state: "skip", summary, detail } : { state: "skip", summary };
}
