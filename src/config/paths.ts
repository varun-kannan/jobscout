/**
 * Every path jobscout touches, derived from one root.
 *
 * The root defaults to ~/jobscout so the whole installation — database,
 * config, profile, drafts — is one folder you can copy, back up, or move.
 * JOBSCOUT_HOME overrides it, which is what the test suite uses.
 */

import { homedir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";

export interface Paths {
  root: string;
  db: string;
  config: string;
  secrets: string;
  profile: string;
  resumeText: string;
  skills: string;
  aliases: string;
  workHistory: string;
  coverLetterStyle: string;
  drafts: string;
  outbox: string;
}

/** Expand a leading `~` and make the path absolute. */
export function expand(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

function resolveRoot(override?: string): string {
  const chosen = override ?? process.env.JOBSCOUT_HOME ?? join(homedir(), "jobscout");
  return expand(chosen);
}

export function buildPaths(root: string): Paths {
  const profile = join(root, "profile");
  return {
    root,
    db: join(root, "jobscout.db"),
    config: join(root, "config.toml"),
    secrets: join(root, "secrets.toml"),
    profile,
    resumeText: join(profile, "resume.extracted.md"),
    skills: join(profile, "skills.toml"),
    aliases: join(profile, "aliases.toml"),
    workHistory: join(profile, "work-history.md"),
    coverLetterStyle: join(profile, "cover-letter-style.md"),
    drafts: join(root, "drafts"),
    outbox: join(root, "outbox"),
  };
}

export function getPaths(override?: string): Paths {
  return buildPaths(resolveRoot(override));
}

/** Directories that must exist for a working installation. */
export function requiredDirs(paths: Paths): string[] {
  return [paths.root, paths.profile, paths.drafts, paths.outbox];
}
