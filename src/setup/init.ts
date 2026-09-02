/**
 * `jobscout init` — the only setup command, and the only repair command.
 *
 * It is idempotent by construction: it runs the same check registry every time,
 * reports what is already healthy, and offers to fix what is not. First run and
 * three-months-later repair are the same code path, so there is exactly one
 * definition of "ready".
 */

import { confirm, isCancel, intro, outro, log as clackLog } from "@clack/prompts";
import {
  PHASES,
  PHASE_TITLES,
  type Check,
  type CheckContext,
  type CheckResult,
  type Phase,
} from "./checks/check.ts";
import { ALL_CHECKS } from "./checks/registry.ts";
import { getPaths, type Paths } from "../config/paths.ts";
import {
  ensureDirs,
  loadConfig,
  loadSecrets,
  saveConfig,
  saveSecrets,
  ConfigError,
} from "../config/load.ts";
import { defaultConfig, type Config, type Secrets } from "../config/schema.ts";
import type { DbHandle } from "../db/db.ts";
import { c, fail, heading, hint, indent, line, ok, pad, skip, warn } from "../output/theme.ts";

export interface InitOptions {
  root?: string;
  assumeYes: boolean;
  dryRun: boolean;
  repair: boolean;
  /** Enable every engine, walking through each credential in turn. */
  all: boolean;
  /** Set up without Claude Code; discovery, matching and ranking still work. */
  noAi: boolean;
}

export interface InitOutcome {
  ok: boolean;
  failures: number;
  warnings: number;
  fixesApplied: number;
}

const TITLE_WIDTH = 22;

function renderResult(check: Check, result: CheckResult): void {
  const label = pad(check.title, TITLE_WIDTH);
  switch (result.state) {
    case "ok":
      line("  " + ok(`${label}${result.summary}`));
      break;
    case "warn":
      line("  " + warn(`${label}${c.yellow(result.summary)}`));
      break;
    case "fail":
      line("  " + fail(`${label}${c.red(result.summary)}`));
      break;
    case "skip":
      line("  " + skip(`${label}${result.summary}`));
      break;
  }
  if (result.detail?.length) {
    line(indent(hint(result.detail.join("\n")), 6));
  }
}

async function askYesNo(question: string, defaultYes: boolean, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return defaultYes;
  const answer = await confirm({ message: question, initialValue: defaultYes });
  if (isCancel(answer)) return false;
  return answer;
}

export async function runInit(options: InitOptions): Promise<InitOutcome> {
  const paths: Paths = getPaths(options.root);

  intro(c.bold("jobscout init"));

  // The data directory has to exist before config can be read from it, and
  // creating an empty directory is harmless even in a dry run.
  //
  // A failure here is not fatal: the environment check reports an unwritable
  // directory in plain language, and it can only do that if it is allowed to
  // run. Throwing here crashed with a raw EACCES before the check was reached.
  if (!options.dryRun) {
    try {
      await ensureDirs(paths);
    } catch {
      // Reported by dataDirCheck below.
    }
  }

  let config: Config;
  let secrets: Secrets;
  // A fresh install has no config.toml, so there is nowhere to set search
  // terms — and with no terms the board engines have no opinion and keep
  // everything. Writing the defaults out on first run gives you a real file
  // to edit rather than an empty directory.
  let configDirtyFromStart = false;
  try {
    const existing = await loadConfig(paths);
    configDirtyFromStart = existing === null;
    config = existing ?? defaultConfig();
    secrets = await loadSecrets(paths);
  } catch (err) {
    if (err instanceof ConfigError) {
      line();
      line(fail(err.message));
      line(hint(`  ${err.path}`));
      if (err.detail) line(indent(hint(err.detail), 2));
      line();
      line(hint("Fix the file by hand, or move it aside and re-run `jobscout init`."));
      return { ok: false, failures: 1, warnings: 0, fixesApplied: 0 };
    }
    throw err;
  }

  if (options.noAi) {
    config = { ...config, ai: { ...config.ai, providers: [] } };
  }
  if (options.all) {
    const { ENGINE_IDS } = await import("../config/schema.ts");
    config = { ...config, engines: { enabled: [...ENGINE_IDS] } };
  }

  // Held in an object rather than a `let`: every write happens inside the
  // context closure below, which TypeScript cannot follow, so a bare `let`
  // would stay narrowed to `null` for the rest of this function.
  const state: { db: DbHandle | null } = { db: null };
  let configDirty = configDirtyFromStart || options.noAi || options.all;
  let secretsDirty = false;

  const ctx: CheckContext = {
    paths,
    get config() {
      return config;
    },
    get secrets() {
      return secrets;
    },
    get db() {
      return state.db;
    },
    assumeYes: options.assumeYes,
    dryRun: options.dryRun,
    setConfig(next) {
      config = next;
      configDirty = true;
    },
    setSecrets(next) {
      secrets = next;
      secretsDirty = true;
    },
    setDb(next) {
      state.db = next;
    },
  };

  let failures = 0;
  let warnings = 0;
  let fixesApplied = 0;

  for (const phase of PHASES) {
    const checks = ALL_CHECKS.filter(
      (check) => check.phase === phase && (check.applies?.(ctx) ?? true),
    );
    if (checks.length === 0) continue;

    line();
    line("  " + heading(PHASE_TITLES[phase as Phase]));

    for (const check of checks) {
      let result = await check.run(ctx);
      renderResult(check, result);

      if (!result.fix) {
        if (result.state === "fail") failures++;
        if (result.state === "warn") warnings++;
        continue;
      }

      const fix = result.fix;

      if (options.dryRun) {
        line(indent(hint(`would offer: ${fix.label}`), 6));
        if (result.state === "fail") failures++;
        if (result.state === "warn") warnings++;
        continue;
      }

      const accepted = await askYesNo(fix.label, fix.defaultYes, options.assumeYes);
      if (!accepted) {
        if (result.state === "fail") failures++;
        if (result.state === "warn") warnings++;
        continue;
      }

      if (fix.manual || !fix.run) {
        if (fix.instructions?.length) {
          line();
          line(indent(fix.instructions.join("\n"), 6));
          line();
        }
        // A manual fix cannot be verified in this run — the user has to act.
        if (result.state === "fail") failures++;
        if (result.state === "warn") warnings++;
        continue;
      }

      try {
        await fix.run(ctx);
        fixesApplied++;
        // Re-run so the report reflects reality rather than the pre-fix state.
        result = await check.run(ctx);
        renderResult(check, result);
        if (result.state === "fail") failures++;
        if (result.state === "warn") warnings++;
      } catch (err) {
        line("  " + fail(`${pad(check.title, TITLE_WIDTH)}fix failed`));
        line(indent(hint(String(err instanceof Error ? err.message : err)), 6));
        failures++;
      }
    }
  }

  if (!options.dryRun) {
    if (configDirty) await saveConfig(paths, config);
    if (secretsDirty) await saveSecrets(paths, secrets);
  }

  state.db?.close();

  line();
  const outcome: InitOutcome = {
    ok: failures === 0,
    failures,
    warnings,
    fixesApplied,
  };

  if (options.dryRun) {
    outro(c.dim("Dry run — nothing was changed."));
    return outcome;
  }

  if (failures === 0 && warnings === 0) {
    outro(c.green("Ready.") + c.dim("  Run `jobscout discover` to start."));
  } else if (failures === 0) {
    outro(
      c.yellow(`Ready, with ${warnings} warning${warnings === 1 ? "" : "s"}.`) +
        c.dim("  Run `jobscout discover` to start."),
    );
  } else {
    outro(
      c.red(`${failures} problem${failures === 1 ? "" : "s"} left.`) +
        c.dim("  Fix them, then run `jobscout init` again."),
    );
  }

  if (fixesApplied > 0) {
    clackLog.info(`${fixesApplied} fix${fixesApplied === 1 ? "" : "es"} applied.`);
  }

  return outcome;
}
