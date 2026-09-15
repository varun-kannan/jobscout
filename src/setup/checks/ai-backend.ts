/**
 * Phase 2: is there an AI backend, and which one.
 *
 * Nothing is chosen for you. A fresh install has an empty chain, and this check
 * offers only the backends that are actually usable on this machine, with none
 * pre-ticked. `--yes` picks nothing.
 */

import {
  caution,
  canAsk,
  pass,
  type Check,
  type CheckContext,
  type CheckResult,
} from "./check.ts";
import { PAID_PROVIDERS } from "../../config/schema.ts";
import { chooseBackend, pickBackends, probeBackends, renderBackends } from "../ai-setup.ts";

export const aiBackendCheck: Check = {
  id: "ai-backend",
  title: "AI backend",
  phase: "dependencies",

  async run(ctx: CheckContext): Promise<CheckResult> {
    const configured = ctx.config.ai.providers;
    const statuses = await probeBackends(ctx.secrets);

    if (configured.length === 0) {
      const usable = statuses.filter((s) => s.available);
      if (usable.length > 0) {
        const detail = [
          ...renderBackends(usable).split("\n"),
          "Discovery, matching and ranking work without one. Scoring and drafting do not.",
        ];
        if (!canAsk(ctx)) {
          return caution("none chosen", {
            detail: [...detail, "Choose with `jobscout init` in a terminal, or in Setup in the UI."],
          });
        }
        return caution("none chosen", {
          detail,
          fix: {
            // The picker has nothing ticked, so saying yes chooses nothing by itself.
            label: "Choose which of these to use?",
            defaultYes: true,
            async run(inner) {
              const picked = await pickBackends(statuses);
              if (picked === null || picked.length === 0) return;
              inner.setConfig({ ...inner.config, ai: { ...inner.config.ai, providers: picked } });
            },
          },
        });
      }
    }

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
      return pass(`${active.label} \u2014 ${active.detail}`, detail);
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

          if (outcome.withoutAi) return;

          inner.setConfig({
            ...inner.config,
            ai: { ...inner.config.ai, providers: outcome.providers },
          });
          if (outcome.secrets !== inner.secrets) inner.setSecrets(outcome.secrets);

          // A paid backend with no ceiling is worth defaulting rather than
          // leaving open, it can be raised, but not accidentally left off.
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
