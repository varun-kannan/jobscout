/**
 * `jobscout config` — read and change settings without hand-editing TOML.
 *
 * Deliberately narrow. Only the settings you change often live here — the
 * budget, the provider chain, per-tier models. Everything else stays in
 * config.toml, which is the actual source of truth and is meant to be edited.
 */

import { defineCommand } from "citty";
import { getPaths } from "../config/paths.ts";
import { loadConfigOrDefault, loadSecrets, saveConfig, saveSecrets } from "../config/load.ts";
import { openAndMigrate } from "../db/db.ts";
import {
  AI_PROVIDERS,
  AI_TIERS,
  PAID_PROVIDERS,
  type AiProvider,
  type AiTier,
} from "../config/schema.ts";
import { BUDGET_PERIODS, periodResets, periodStart, spendSince, type BudgetPeriod } from "../ai/budget.ts";
import { formatUsd, PRICES_UPDATED } from "../ai/pricing.ts";
import { c, hint, line, ok, pad, warn } from "../output/theme.ts";

export const configCommand = defineCommand({
  meta: { name: "config", description: "Show or change settings" },
  args: {
    budget: { type: "string", description: "Spend limit in USD (0 for no limit)" },
    period: { type: "string", description: `Budget period: ${BUDGET_PERIODS.join(" | ")}` },
    providers: { type: "string", description: "Provider chain, in order, comma-separated" },
    tier: { type: "string", description: "Set a tier: <tier>=<provider>:<model>" },
    "clear-tier": { type: "string", description: "Remove a tier override" },
    root: { type: "string", description: "Data directory" },
  },

  async run({ args }) {
    const paths = getPaths(args.root as string | undefined);
    const config = await loadConfigOrDefault(paths);
    const secrets = await loadSecrets(paths);
    let dirty = false;

    /* — budget — */
    // Period first: the limit's confirmation message names it, so applying
    // them the other way round reports the period being replaced.
    if (args.period !== undefined) {
      const period = String(args.period) as BudgetPeriod;
      if (!BUDGET_PERIODS.includes(period)) {
        line(warn(`Unknown period "${period}". One of: ${BUDGET_PERIODS.join(", ")}`));
        process.exitCode = 1;
        return;
      }
      config.ai.budget.period = period;
      dirty = true;
      line(ok(`Budget period set to ${period}.`));
    }

    if (args.budget !== undefined) {
      const limit = Number(args.budget);
      if (!Number.isFinite(limit) || limit < 0) {
        line(warn(`"${args.budget}" is not a valid amount.`));
        process.exitCode = 1;
        return;
      }
      config.ai.budget.limit = limit;
      dirty = true;
      line(
        ok(
          limit === 0
            ? "Spend limit removed."
            : `Spend limit set to ${formatUsd(limit)} ${config.ai.budget.period}.`,
        ),
      );
    }

    /* — provider chain — */
    if (args.providers !== undefined) {
      const chain = String(args.providers)
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean) as AiProvider[];

      const unknown = chain.filter((p) => !AI_PROVIDERS.includes(p));
      if (unknown.length) {
        line(warn(`Unknown provider(s): ${unknown.join(", ")}`));
        line(hint(`  One of: ${AI_PROVIDERS.join(", ")}`));
        process.exitCode = 1;
        return;
      }

      // A paid provider without its key would fail on first use rather than
      // at the moment it was configured, which is a worse place to find out.
      const missingKey = chain.filter((p) => {
        if (!PAID_PROVIDERS.includes(p)) return false;
        if (p === "anthropic") return !secrets.anthropic?.apiKey;
        if (p === "openai") return !secrets.openai?.apiKey;
        if (p === "gemini") return !secrets.gemini?.apiKey;
        return false;
      });
      if (missingKey.length) {
        line(warn(`No API key stored for: ${missingKey.join(", ")}`));
        line(hint(`  Add one to ${paths.secrets}, for example:`));
        line(hint(`    [openai]`));
        line(hint(`    apiKey = "sk-..."`));
        process.exitCode = 1;
        return;
      }

      config.ai.providers = chain;
      dirty = true;
      line(ok(`Provider chain: ${chain.join(" → ")}`));
      if (chain.some((p) => PAID_PROVIDERS.includes(p)) && config.ai.budget.limit === 0) {
        line(warn("  A paid provider is enabled with no spend limit."));
        line(hint("  Set one with `jobscout config --budget 5`."));
      }
    }

    /* — per-tier models — */
    if (args.tier !== undefined) {
      const [tier, spec] = String(args.tier).split("=");
      const [provider, ...modelParts] = (spec ?? "").split(":");
      const model = modelParts.join(":");

      if (!tier || !AI_TIERS.includes(tier as AiTier)) {
        line(warn(`Unknown tier "${tier}". One of: ${AI_TIERS.join(", ")}`));
        process.exitCode = 1;
        return;
      }
      if (!provider || !AI_PROVIDERS.includes(provider as AiProvider) || !model) {
        line(warn(`Use --tier ${tier}=<provider>:<model>`));
        line(hint(`  e.g. --tier extract=ollama:llama3.1:8b`));
        process.exitCode = 1;
        return;
      }

      config.ai.tiers[tier as AiTier] = { provider: provider as AiProvider, model };
      dirty = true;
      line(ok(`${tier} → ${provider} / ${model}`));
    }

    if (args["clear-tier"] !== undefined) {
      const tier = String(args["clear-tier"]) as AiTier;
      if (!AI_TIERS.includes(tier)) {
        line(warn(`Unknown tier "${tier}".`));
        process.exitCode = 1;
        return;
      }
      delete config.ai.tiers[tier];
      dirty = true;
      line(ok(`${tier} override removed — it will use the default chain.`));
    }

    if (dirty) {
      await saveConfig(paths, config);
      await saveSecrets(paths, secrets);
      return;
    }

    /* — show — */
    const db = await openAndMigrate(paths.db);
    try {
      const spend = spendSince(db.raw, periodStart(config.ai.budget.period));
      const resets = periodResets(config.ai.budget.period);

      line();
      line(`  ${c.bold("AI")}`);
      line(`    ${pad("providers", 14)}${config.ai.providers.join(" → ") || c.dim("none")}`);
      line(`    ${pad("model", 14)}${config.ai.model}`);

      for (const tier of AI_TIERS) {
        const override = config.ai.tiers[tier];
        line(
          `    ${pad(tier, 14)}` +
            (override
              ? `${override.provider} / ${override.model}`
              : c.dim("(uses the default chain)")),
        );
      }

      line();
      line(`  ${c.bold("Budget")}`);
      line(
        `    ${pad("limit", 14)}` +
          (config.ai.budget.limit > 0
            ? `${formatUsd(config.ai.budget.limit)} ${config.ai.budget.period}`
            : c.dim("none")),
      );
      line(`    ${pad("spent", 14)}${formatUsd(spend.total)} ${c.dim(`(estimated, ${spend.calls} call(s))`)}`);
      if (resets) line(`    ${pad("resets", 14)}${c.dim(resets.toISOString().slice(0, 10))}`);
      // Prices drift, and a stale table enforces the wrong number silently.
      line(`    ${pad("price table", 14)}${c.dim(`updated ${PRICES_UPDATED}`)}`);

      line();
      line(c.dim(`  Everything else lives in ${paths.config}.`));
      line();
    } finally {
      db.close();
    }
  },
});
