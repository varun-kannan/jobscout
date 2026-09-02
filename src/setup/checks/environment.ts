/**
 * Phase 1 — is this machine able to host an installation at all?
 */

import { access, constants, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { version as bunVersion } from "bun";
import {
  caution,
  pass,
  problem,
  type Check,
  type CheckContext,
  type CheckResult,
} from "./check.ts";
import { requiredDirs } from "../../config/paths.ts";
import { openAndMigrate, openReadOnly, currentVersion, SCHEMA_VERSION } from "../../db/db.ts";

export const platformCheck: Check = {
  id: "platform",
  title: "Platform",
  phase: "environment",
  async run(): Promise<CheckResult> {
    return pass(`jobscout on ${process.platform} ${process.arch} · bun ${bunVersion}`);
  },
};

async function isWritable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export const dataDirCheck: Check = {
  id: "data-dir",
  title: "Data directory",
  phase: "environment",
  async run(ctx: CheckContext): Promise<CheckResult> {
    const { paths } = ctx;
    const missing: string[] = [];

    for (const dir of requiredDirs(paths)) {
      try {
        const info = await stat(dir);
        if (!info.isDirectory()) {
          return problem(`${dir} exists but is not a directory`, {
            detail: ["Move or remove that file, then run `jobscout init` again."],
          });
        }
      } catch {
        missing.push(dir);
      }
    }

    if (missing.length === 0) {
      if (!(await isWritable(paths.root))) {
        return problem(`${paths.root} is not writable`, {
          detail: ["Check the directory's permissions, or set JOBSCOUT_HOME elsewhere."],
        });
      }
      return pass(paths.root);
    }

    return problem(`${paths.root} — ${missing.length} folder(s) missing`, {
      fix: {
        label: `Create the data directory at ${paths.root}?`,
        defaultYes: true,
        async run(inner) {
          for (const dir of requiredDirs(inner.paths)) {
            await mkdir(dir, { recursive: true });
          }
        },
      },
    });
  },
};

export const databaseCheck: Check = {
  id: "database",
  title: "Database",
  phase: "environment",
  async run(ctx: CheckContext): Promise<CheckResult> {
    // The data directory check runs first; if it failed, there is nowhere to
    // put a database and reporting a second failure would just be noise.
    try {
      await stat(ctx.paths.root);
    } catch {
      return problem("waiting on the data directory");
    }

    // A dry run reports; it does not repair. Opening the normal way would
    // create the file and set journal_mode before reading anything, so
    // `doctor` would quietly bring into being the database it is checking for.
    if (ctx.dryRun) {
      if (!existsSync(ctx.paths.db)) {
        return problem("not created yet", {
          detail: ["`jobscout init` creates it."],
        });
      }
      try {
        const handle = openReadOnly(ctx.paths.db);
        ctx.setDb(handle);
        const version = currentVersion(handle.raw);
        return version < SCHEMA_VERSION
          ? caution(`schema v${version} — init would migrate to v${SCHEMA_VERSION}`)
          : pass(`schema v${version}`);
      } catch (err) {
        return problem("could not open the database", {
          detail: [String(err instanceof Error ? err.message : err), `Database path: ${ctx.paths.db}`],
        });
      }
    }

    try {
      const handle = await openAndMigrate(ctx.paths.db);
      ctx.setDb(handle);
      const version = currentVersion(handle.raw);
      return pass(`schema v${version}`);
    } catch (err) {
      return problem("could not open the database", {
        detail: [
          String(err instanceof Error ? err.message : err),
          `Database path: ${ctx.paths.db}`,
        ],
      });
    }
  },
};

export const environmentChecks: Check[] = [platformCheck, dataDirCheck, databaseCheck];
