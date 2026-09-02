/**
 * Phase 4 — are the enabled engines actually able to run?
 *
 * Keyless engines are always ready. The five that need something each report
 * what is missing rather than failing silently at discovery time.
 */

import {
  caution,
  pass,
  skipped,
  type Check,
  type CheckContext,
  type CheckResult,
} from "./check.ts";
import { KEYLESS_ENGINES, engineRequirement, type EngineId } from "../../config/schema.ts";
import { SEED_BOARDS } from "../../engines/seed-boards.ts";
import { addBoard } from "../../db/jobs.ts";

/** Does this engine have everything it needs to run right now? */
export function engineReady(id: EngineId, ctx: CheckContext): boolean {
  switch (id) {
    case "adzuna":
      return Boolean(ctx.secrets.adzuna?.appId && ctx.secrets.adzuna?.appKey);
    case "careerjet":
      return Boolean(ctx.secrets.careerjet?.affid);
    case "jooble":
      return Boolean(ctx.secrets.jooble?.key);
    case "jobspy":
      return false; // resolved by the python check, which owns the sidecar
    default:
      return true;
  }
}

export const enabledEnginesCheck: Check = {
  id: "engines-enabled",
  title: "Enabled engines",
  phase: "engines",

  async run(ctx: CheckContext): Promise<CheckResult> {
    const enabled = ctx.config.engines.enabled;

    if (enabled.length === 0) {
      return caution("none enabled", {
        detail: ["Nothing will be discovered until at least one engine is on."],
        fix: {
          label: "Enable the 15 keyless engines?",
          defaultYes: true,
          async run(inner) {
            inner.setConfig({
              ...inner.config,
              engines: { enabled: [...KEYLESS_ENGINES] },
            });
          },
        },
      });
    }

    const keyless = enabled.filter((id) => KEYLESS_ENGINES.includes(id));
    const needing = enabled.filter((id) => !KEYLESS_ENGINES.includes(id));
    const blocked = needing.filter((id) => !engineReady(id, ctx));

    const summary =
      blocked.length === 0
        ? `${enabled.length} enabled, all ready`
        : `${enabled.length} enabled, ${blocked.length} waiting on setup`;

    const detail = [`Keyless: ${keyless.length}`];
    for (const id of needing) {
      const ready = engineReady(id, ctx);
      detail.push(`${ready ? "ready" : "needs"} ${id}${ready ? "" : ` — ${engineRequirement(id)}`}`);
    }

    return blocked.length === 0 ? pass(summary, detail) : caution(summary, { detail });
  },
};

export const credentialsCheck: Check = {
  id: "engine-credentials",
  title: "Engine credentials",
  phase: "engines",

  applies(ctx) {
    return ctx.config.engines.enabled.some((id) => !KEYLESS_ENGINES.includes(id));
  },

  async run(ctx: CheckContext): Promise<CheckResult> {
    const needing = ctx.config.engines.enabled.filter((id) => !KEYLESS_ENGINES.includes(id));
    const missing = needing.filter((id) => id !== "jobspy" && !engineReady(id, ctx));

    if (missing.length === 0) return pass("all present");

    const signup: Record<string, string> = {
      adzuna: "https://developer.adzuna.com/",
      careerjet: "https://www.careerjet.com/partners/api/",
      jooble: "https://jooble.org/api/about",
    };

    return caution(`${missing.length} missing`, {
      detail: missing.map((id) => `${id} — ${engineRequirement(id)}`),
      fix: {
        label: "Show where to get them?",
        defaultYes: true,
        manual: true,
        instructions: [
          ...missing.flatMap((id) =>
            signup[id]
              ? [`${id}:  ${signup[id]}`]
              : [`${id}:  see the documentation`],
          ),
          "",
          `Add them to ${ctx.paths.secrets}, then re-run \`jobscout init\`.`,
        ],
      },
    });
  },
};

export const pythonCheck: Check = {
  id: "python",
  title: "Python (JobSpy)",
  phase: "engines",

  applies(ctx) {
    return ctx.config.engines.enabled.includes("jobspy");
  },

  async run(): Promise<CheckResult> {
    for (const bin of ["python3", "python"]) {
      try {
        const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
        const [out, code] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        if (code !== 0) continue;
        const match = out.match(/(\d+)\.(\d+)/);
        if (!match) continue;
        const major = Number(match[1]);
        const minor = Number(match[2]);
        if (major > 3 || (major === 3 && minor >= 10)) {
          return pass(`${bin} ${major}.${minor}`);
        }
        return caution(`${bin} ${major}.${minor} is too old`, {
          detail: ["JobSpy needs Python 3.10 or newer."],
        });
      } catch {
        continue;
      }
    }

    return caution("not found", {
      detail: ["JobSpy is enabled but has no Python to run on. It will be skipped."],
      fix: {
        label: "Show how to install Python?",
        defaultYes: true,
        manual: true,
        instructions:
          process.platform === "darwin"
            ? [
                "This install needs your password, so here is the command",
                "rather than jobscout running it:",
                "",
                "    brew install python@3.12",
                "",
                "Then re-run `jobscout init`.",
              ]
            : [
                "Install Python 3.10+ with your system package manager, then",
                "re-run `jobscout init`.",
              ],
      },
    });
  },
};

export const noBoardsYetCheck: Check = {
  id: "boards",
  title: "Company boards",
  phase: "boards",

  async run(ctx: CheckContext): Promise<CheckResult> {
    if (!ctx.db) return skipped("waiting on the database");

    const row = ctx.db.raw
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM boards WHERE active = 1")
      .get();
    const count = row?.n ?? 0;

    if (count > 0) return pass(`${count} active`);

    return caution("none yet", {
      detail: [
        "ATS engines poll company boards, so they return nothing until some are known.",
      ],
      fix: {
        label: `Add ${SEED_BOARDS.length} starter boards to get going?`,
        defaultYes: true,
        async run(inner) {
          if (!inner.db) throw new Error("database not open");
          for (const board of SEED_BOARDS) addBoard(inner.db.raw, board);
        },
      },
    });
  },
};

export const engineChecks: Check[] = [
  enabledEnginesCheck,
  credentialsCheck,
  pythonCheck,
  noBoardsYetCheck,
];
