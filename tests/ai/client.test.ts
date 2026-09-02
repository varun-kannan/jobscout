import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { migrate, openMemoryDb } from "../../src/db/db.ts";
import {
  BudgetExceededError,
  NoAiError,
  createAiClient,
  type AiClient,
} from "../../src/ai/client.ts";
import { defaultConfig, type AiProvider, type Config } from "../../src/config/schema.ts";
import { parseJson, validate, ProviderError } from "../../src/ai/providers/provider.ts";
import { recordSpend } from "../../src/ai/budget.ts";

const schema = z.object({ score: z.number().int().min(1).max(5), reason: z.string() });

function setup(overrides: Partial<Config["ai"]> = {}) {
  const handle = openMemoryDb();
  migrate(handle.raw);
  const base = defaultConfig();
  const config: Config = { ...base, ai: { ...base.ai, ...overrides } };
  return { handle, config };
}

function client(overrides: Partial<Config["ai"]> = {}, secrets = {}): {
  ai: AiClient;
  handle: ReturnType<typeof openMemoryDb>;
} {
  const { handle, config } = setup(overrides);
  return {
    ai: createAiClient({ db: handle.raw, config, secrets, cwd: "/tmp" }),
    handle,
  };
}

describe("provider chain", () => {
  test("an empty chain yields a client that refuses rather than pretends", async () => {
    const { ai, handle } = client({ providers: [] });
    expect(await ai.available()).toBe(false);
    expect(await ai.describe()).toBe("none");
    await expect(ai.ask({ instruction: "x", schema })).rejects.toBeInstanceOf(NoAiError);
    handle.close();
  });

  test("a chain of unavailable providers reports unavailable, not an error", async () => {
    // Neither CLI is installed here, and no key is set.
    const { ai, handle } = client({ providers: ["claude-code", "gemini-cli", "openai"] });
    expect(await ai.available()).toBe(false);
    handle.close();
  });

  /** A missing CLI or unset key must cost nothing, not fail the run. */
  test("falls through a provider whose key is missing", async () => {
    const { ai, handle } = client(
      { providers: ["openai", "anthropic"] },
      { anthropic: { apiKey: "sk-test" } },
    );
    // openai has no key, so anthropic answers for it.
    expect(await ai.describe()).toBe("Anthropic API");
    handle.close();
  });

  test("`none` in the chain is ignored rather than selected", async () => {
    const { ai, handle } = client(
      { providers: ["none" as AiProvider, "anthropic"] },
      { anthropic: { apiKey: "sk-test" } },
    );
    expect(await ai.available()).toBe(true);
    handle.close();
  });
});

describe("budget authorisation", () => {
  const ai = (limit: number, period: "weekly" | "monthly" | "none" = "monthly") =>
    client(
      {
        providers: ["anthropic"],
        model: "claude-sonnet-5",
        budget: { limit, period },
      },
      { anthropic: { apiKey: "sk-test" } },
    );

  test("allows a stage when there is no limit", () => {
    const { ai: c, handle } = ai(0);
    expect(() => c.authoriseStage({ calls: 1000, averageChars: 20_000 })).not.toThrow();
    handle.close();
  });

  test("allows a stage that fits inside the limit", () => {
    const { ai: c, handle } = ai(10);
    expect(() => c.authoriseStage({ calls: 5, averageChars: 4_000 })).not.toThrow();
    handle.close();
  });

  /**
   * The whole point of checking before the stage: a run either does a stage
   * completely or never begins it, so nothing is left half-written.
   */
  test("refuses a stage whose projected cost exceeds what is left", () => {
    const { ai: c, handle } = ai(0.01);
    expect(() => c.authoriseStage({ calls: 500, averageChars: 12_000 })).toThrow(
      BudgetExceededError,
    );
    handle.close();
  });

  test("refuses once the period's spend already exceeds the limit", () => {
    const { handle, config } = setup({
      providers: ["anthropic"],
      budget: { limit: 1, period: "monthly" },
    });
    // Spend the whole limit before asking.
    recordSpend(handle.raw, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      stage: "score",
      reportedUsd: 1.5,
    });
    const c = createAiClient({
      db: handle.raw,
      config,
      secrets: { anthropic: { apiKey: "k" } },
      cwd: "/tmp",
    });
    expect(() => c.authoriseStage({ calls: 1, averageChars: 100 })).toThrow(/Already spent/);
    handle.close();
  });

  test("the refusal names the command that raises the limit", () => {
    const { ai: c, handle } = ai(0.001);
    try {
      c.authoriseStage({ calls: 900, averageChars: 15_000 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect((err as Error).message).toContain("jobscout config --budget");
    }
    handle.close();
  });

  test("spending in a previous period does not count against this one", () => {
    const { handle, config } = setup({
      providers: ["anthropic"],
      budget: { limit: 1, period: "weekly" },
    });
    // Backdate well beyond the current week.
    handle.raw.run(
      `INSERT INTO ai_spend (at, provider, model, stage, estimated_usd, cost_source)
       VALUES (?, 'anthropic', 'claude-sonnet-5', 'score', 5.0, 'reported')`,
      [new Date(Date.now() - 30 * 86_400_000).toISOString()],
    );
    const c = createAiClient({
      db: handle.raw,
      config,
      secrets: { anthropic: { apiKey: "k" } },
      cwd: "/tmp",
    });
    expect(() => c.authoriseStage({ calls: 1, averageChars: 500 })).not.toThrow();
    handle.close();
  });

  test("a client with no AI authorises everything, because nothing is spent", () => {
    const { ai: c, handle } = client({ providers: [], budget: { limit: 0.0001, period: "monthly" } });
    expect(() => c.authoriseStage({ calls: 10_000, averageChars: 50_000 })).not.toThrow();
    handle.close();
  });
});

describe("response parsing", () => {
  test("accepts clean JSON", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  });

  test("recovers JSON from a fenced block", () => {
    expect(parseJson('Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test("recovers JSON surrounded by prose", () => {
    expect(parseJson('Sure! {"a":1} — anything else?')).toEqual({ a: 1 });
  });

  test("returns undefined when there is no JSON at all", () => {
    expect(parseJson("I cannot help with that.")).toBeUndefined();
    expect(parseJson("")).toBeUndefined();
  });
});

describe("validate", () => {
  test("passes a conforming answer through", () => {
    expect(validate(schema, { score: 4, reason: "ok" }, "openai")).toEqual({
      score: 4,
      reason: "ok",
    });
  });

  /** A shape mismatch is usually a one-off, so it is marked worth retrying. */
  test("rejects a non-conforming answer as retryable, naming the field", () => {
    try {
      validate(schema, { score: 11, reason: "nope" }, "openai");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(true);
      expect((err as Error).message).toContain("score");
    }
  });

  test("rejects a missing answer rather than defaulting it", () => {
    expect(() => validate(schema, undefined, "gemini")).toThrow(ProviderError);
  });
});
