/**
 * Choosing a backend, spending within a limit, and recording what it cost.
 *
 * Three ideas hold this together:
 *
 *   - **Tier by task.** `extract` runs ~120 times per discovery and asks only
 *     for structured extraction; `write` runs a handful of times and is the one
 *     place quality is the whole point. Matching model to task saves money on
 *     every run, not only once a limit is reached.
 *   - **Fall through, do not fail.** Providers are tried in order until one is
 *     available, so a missing CLI or unset key costs nothing.
 *   - **Stop at stage boundaries.** A budget is checked before a stage starts,
 *     with the whole stage's projected cost, so a run either completes a stage
 *     or never begins it. Nothing is left half-written.
 */

import type { ZodType } from "zod";
import type { Database } from "bun:sqlite";
import type { AiProvider, AiTier, Config, Secrets } from "../config/schema.ts";
import { checkBudget, recordSpend, type BudgetVerdict } from "./budget.ts";
import { approximateTokens, estimateCost, formatUsd } from "./pricing.ts";
import type { AiProviderClient, AskInput } from "./providers/provider.ts";
import { ProviderError } from "./providers/provider.ts";
import { AnthropicClient, ClaudeCodeClient } from "./providers/anthropic.ts";
import { OpenAiClient } from "./providers/openai.ts";
import { GeminiClient } from "./providers/gemini.ts";
import { OllamaClient } from "./providers/ollama.ts";
import { AgentCliClient } from "./providers/agent-cli.ts";

export { ProviderError } from "./providers/provider.ts";

export class AiError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AiError";
  }
}

/** No backend is configured or reachable. Callers may catch this and degrade. */
export class NoAiError extends AiError {
  constructor(message = "No AI available. Run `jobscout init` to set one up.") {
    super(message);
    this.name = "NoAiError";
  }
}

/** The budget stopped the run. Distinct from a failure — nothing is wrong. */
export class BudgetExceededError extends AiError {
  constructor(
    message: string,
    readonly verdict: BudgetVerdict,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export interface AskOptions<T> {
  instruction: string;
  context?: string;
  system?: string;
  schema: ZodType<T>;
  /** Which kind of work this is. Decides the model. */
  tier?: AiTier;
  /** Recorded against the spend, so cost can be attributed to the work. */
  stage?: string;
  signal?: AbortSignal;
}

export interface AiClient {
  available(): Promise<boolean>;
  /** The backend that would answer, once resolved. */
  describe(): Promise<string>;
  ask<T>(options: AskOptions<T>): Promise<T>;
  /**
   * May a stage of this size run? Called before the stage starts.
   * Throws BudgetExceededError when it may not.
   */
  authoriseStage(estimate: { calls: number; averageChars: number; tier?: AiTier }): void;
}

/* ── construction ─────────────────────────────────────────────────── */

function buildProvider(
  id: AiProvider,
  secrets: Secrets,
  cwd: string,
): AiProviderClient | null {
  switch (id) {
    case "claude-code":
      return new ClaudeCodeClient(cwd);
    case "ollama":
      return new OllamaClient();
    case "anthropic":
      return secrets.anthropic?.apiKey ? new AnthropicClient(secrets.anthropic.apiKey) : null;
    case "openai":
      return secrets.openai?.apiKey ? new OpenAiClient(secrets.openai.apiKey) : null;
    case "gemini":
      return secrets.gemini?.apiKey ? new GeminiClient(secrets.gemini.apiKey) : null;
    case "gemini-cli":
      return new AgentCliClient("gemini-cli", cwd);
    case "codex-cli":
      return new AgentCliClient("codex-cli", cwd);
    default:
      return null;
  }
}

/** Default model per provider, when a tier does not name one. */
const DEFAULT_MODELS: Partial<Record<AiProvider, string>> = {
  "claude-code": "claude-sonnet-5",
  anthropic: "claude-sonnet-5",
  openai: "gpt-4.1-mini",
  gemini: "gemini-2.5-flash",
  ollama: "llama3.1:8b",
  "gemini-cli": "gemini-2.5-flash",
  "codex-cli": "gpt-5",
};

class Router implements AiClient {
  /** Cached availability, so a missing CLI is probed once rather than per call. */
  private resolved: AiProviderClient | null | undefined;

  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly secrets: Secrets,
    private readonly cwd: string,
  ) {}

  private chain(): AiProvider[] {
    return this.config.ai.providers.filter((p) => p !== "none");
  }

  /** The first provider in the chain that is actually usable. */
  private async resolve(): Promise<AiProviderClient | null> {
    if (this.resolved !== undefined) return this.resolved;
    for (const id of this.chain()) {
      const provider = buildProvider(id, this.secrets, this.cwd);
      if (provider && (await provider.available())) {
        this.resolved = provider;
        return provider;
      }
    }
    this.resolved = null;
    return null;
  }

  /** Which provider and model should answer this tier. */
  private async forTier(tier: AiTier | undefined): Promise<{ provider: AiProviderClient; model: string }> {
    const override = tier ? this.config.ai.tiers[tier] : undefined;

    if (override) {
      const provider = buildProvider(override.provider, this.secrets, this.cwd);
      if (provider && (await provider.available())) {
        return { provider, model: override.model };
      }
      // A configured tier that is not usable falls back rather than failing —
      // an unpulled Ollama model should not stop the run.
    }

    const provider = await this.resolve();
    if (!provider) throw new NoAiError();

    const model =
      override?.model ??
      (provider.id === this.chain()[0] ? this.config.ai.model : undefined) ??
      DEFAULT_MODELS[provider.id] ??
      this.config.ai.model;

    return { provider, model };
  }

  async available(): Promise<boolean> {
    return (await this.resolve()) !== null;
  }

  async describe(): Promise<string> {
    const provider = await this.resolve();
    return provider ? provider.label : "none";
  }

  authoriseStage(estimate: { calls: number; averageChars: number; tier?: AiTier }): void {
    const budget = this.config.ai.budget;
    if (budget.limit <= 0 || budget.period === "none") return;

    const override = estimate.tier ? this.config.ai.tiers[estimate.tier] : undefined;
    const model = override?.model ?? this.config.ai.model;

    // Output is assumed to be roughly a quarter of input — enough to size a
    // check without pretending to precision the estimate does not have.
    const inputTokens = approximateTokens("x".repeat(estimate.averageChars));
    const perCall = estimateCost(model, inputTokens, Math.ceil(inputTokens / 4)) ?? 0;
    const projected = perCall * estimate.calls;

    const verdict = checkBudget(this.db, budget, projected);
    if (!verdict.ok) {
      throw new BudgetExceededError(
        `${verdict.reason} Raise it with \`jobscout config --budget <amount>\`, ` +
          `or set it to 0 for no limit.`,
        verdict,
      );
    }
  }

  async ask<T>(options: AskOptions<T>): Promise<T> {
    const { provider, model } = await this.forTier(options.tier);

    const input: AskInput<T> = {
      instruction: options.instruction,
      context: options.context,
      system: options.system,
      schema: options.schema,
      model,
      signal: options.signal,
    };

    try {
      const result = await provider.ask(input);
      recordSpend(this.db, {
        provider: provider.id,
        model: result.model,
        stage: options.stage ?? options.tier ?? "unknown",
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        reportedUsd: result.usage.reportedUsd,
      });
      return result.value;
    } catch (err) {
      if (err instanceof ProviderError) {
        throw new AiError(`${provider.label}: ${err.message}`, err.retryable);
      }
      throw err;
    }
  }
}

/* ── no AI ────────────────────────────────────────────────────────── */

class NullClient implements AiClient {
  async available(): Promise<boolean> {
    return false;
  }
  async describe(): Promise<string> {
    return "none";
  }
  authoriseStage(): void {
    // Nothing is spent, so nothing needs authorising.
  }
  // Takes the interface's parameter even though it ignores it: a narrower
  // signature is not an implementation of the wider one.
  async ask<T>(_options: AskOptions<T>): Promise<T> {
    throw new NoAiError();
  }
}

export function createAiClient(options: {
  db: Database;
  config: Config;
  secrets: Secrets;
  cwd: string;
}): AiClient {
  const chain = options.config.ai.providers.filter((p) => p !== "none");
  if (chain.length === 0) return new NullClient();
  return new Router(options.db, options.config, options.secrets, options.cwd);
}

export { formatUsd };
