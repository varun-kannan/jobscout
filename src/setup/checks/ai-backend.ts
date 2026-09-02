/**
 * Phase 2 — is there an AI backend, and which one.
 *
 * Replaces an earlier Claude-Code-only check. The order matters: agent CLIs
 * are preferred because they spend a subscription you already hold rather than
 * charging per call, Ollama next because it is free and local, and a paid API
 * only when you ask for one.
 *
 * The common case — a CLI already installed — passes silently. The prompt only
 * appears when nothing is usable.
 */

import {
  caution,
  pass,
  skipped,
  type Check,
  type CheckContext,
  type CheckResult,
} from "./check.ts";
import { PAID_PROVIDERS } from "../../config/schema.ts";
import { chooseBackend, probeBackends, renderBackends } from "../ai-setup.ts";

export const aiBackendCheck: Check = {
  id: "ai-backend",
  title: "AI backend",
  phase: "dependencies",

  async run(ctx: CheckContext): Promise<CheckResult> {
    const configured = ctx.config.ai.providers;

    if (configured.length === 0) {
      return skipped("no-AI mode", [
        "Discovery, matching and ranking all work. Drafting does not.",
        "Re-run `jobscout init` to set one up.",
      ]);
    }

    const statuses = await probeBackends(ctx.secrets);
    const byId = new Map(statuses.map((s) => [s.id, s]));

    // The first configured backend that is actually usable.
    const active = configured.map((id) => byId.get(id)).find((s) => s?.available);

    if (active) {
      const others = configured
        .map((id) => byId.get(id))
        .filter((s): s is NonNullable<typeof s> => Boolean(s) && s!.id !== active.id);
      const detail =
        others.length > 0
          ? [`fallbacks: ${others.map((s) => `${s.label} (${s.detail})`).join(", ")}`]
          : undefined;
      return pass(`${active.label} — ${active.detail}`, detail);
    }

    return caution("none available", {
      detail: renderBackends(statuses).split("\n"),
      fix: {
        label: "Set one up now?",
        defaultYes: true,
        async run(inner) {
          const outcome = await chooseBackend(statuses, inner.secrets, {
            // `--yes` and a non-terminal both mean nobody is there to answer.
            interactive: !inner.assumeYes && process.stdin.isTTY === true,
          });

          if (outcome.withoutAi) {
            // Only an explicit choice empties the chain. A scripted run that
            // simply found nothing keeps its preferences, so installing a
            // backend later is enough on its own.
            inner.setConfig({
              ...inner.config,
              ai: { ...inner.config.ai, providers: outcome.providers },
            });
            return;
          }

          inner.setConfig({
            ...inner.config,
            ai: { ...inner.config.ai, providers: outcome.providers },
          });
          if (outcome.secrets !== inner.secrets) inner.setSecrets(outcome.secrets);

          // A paid backend with no ceiling is worth defaulting rather than
          // leaving open — it can be raised, but not accidentally left off.
          const paid = outcome.providers.some((p) => PAID_PROVIDERS.includes(p));
          if (paid && inner.config.ai.budget.limit === 0) {
            inner.setConfig({
              ...inner.config,
              ai: {
                ...inner.config.ai,
                providers: outcome.providers,
                budget: { ...inner.config.ai.budget, limit: 5 },
              },
            });
          }
        },
      },
    });
  },
};
