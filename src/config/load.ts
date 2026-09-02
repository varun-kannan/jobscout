/**
 * Loading and saving config.toml and secrets.toml.
 *
 * Both are parsed through zod on the way in, so a hand-edited file with a typo
 * fails loudly at startup rather than surfacing as a strange bug six stages later.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  configSchema,
  defaultConfig,
  secretsSchema,
  type Config,
  type Secrets,
} from "./schema.ts";
import { requiredDirs, type Paths } from "./paths.ts";

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Render zod's issue list as something a person can act on. */
function formatIssues(error: unknown): string {
  const issues = (error as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues;
  if (!issues) return String(error);
  return issues
    .map((i) => {
      const where = i.path.length ? i.path.join(".") : "(root)";
      return `  ${where}: ${i.message}`;
    })
    .join("\n");
}

export async function loadConfig(paths: Paths): Promise<Config | null> {
  const raw = await readIfExists(paths.config);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    throw new ConfigError("config.toml is not valid TOML", paths.config, String(err));
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError("config.toml has invalid values", paths.config, formatIssues(result.error));
  }
  return result.data;
}

export async function saveConfig(paths: Paths, config: Config): Promise<void> {
  await mkdir(dirname(paths.config), { recursive: true });
  const body = [
    "# jobscout configuration",
    "# Preferences only — safe to share. Credentials live in secrets.toml.",
    "",
    stringifyToml(config as unknown as Record<string, unknown>),
    "",
  ].join("\n");
  await writeFile(paths.config, body, "utf8");
}

export async function loadSecrets(paths: Paths): Promise<Secrets> {
  const raw = await readIfExists(paths.secrets);
  if (raw === null) return {};

  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    throw new ConfigError("secrets.toml is not valid TOML", paths.secrets, String(err));
  }

  const result = secretsSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      "secrets.toml has invalid values",
      paths.secrets,
      formatIssues(result.error),
    );
  }
  return result.data;
}

/**
 * Secrets are written at mode 600 and re-chmodded on every save, so a file
 * that drifted to group-readable is corrected the next time anything touches it.
 */
export async function saveSecrets(paths: Paths, secrets: Secrets): Promise<void> {
  await mkdir(dirname(paths.secrets), { recursive: true });
  const body = [
    "# jobscout credentials — DO NOT SHARE, DO NOT COMMIT",
    "# This file is kept at mode 600.",
    "",
    stringifyToml(secrets as unknown as Record<string, unknown>),
    "",
  ].join("\n");
  await writeFile(paths.secrets, body, { encoding: "utf8", mode: 0o600 });
  await chmod(paths.secrets, 0o600);
}

export async function ensureDirs(paths: Paths): Promise<void> {
  for (const dir of requiredDirs(paths)) {
    await mkdir(dir, { recursive: true });
  }
}

/** Load config, falling back to defaults when the file does not exist yet. */
export async function loadConfigOrDefault(paths: Paths): Promise<Config> {
  return (await loadConfig(paths)) ?? defaultConfig();
}
