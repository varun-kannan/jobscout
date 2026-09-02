import { describe, expect, test } from "bun:test";
import { migrate, openMemoryDb } from "../../src/db/db.ts";
import {
  checkBudget,
  periodResets,
  periodStart,
  recordSpend,
  spendSince,
} from "../../src/ai/budget.ts";
import { approximateTokens, estimateCost, formatUsd, priceFor } from "../../src/ai/pricing.ts";

function db() {
  const handle = openMemoryDb();
  migrate(handle.raw);
  return handle;
}

describe("periodStart", () => {
  test("a month starts on the 1st", () => {
    const start = periodStart("monthly", new Date("2026-08-28T15:00:00"))!;
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(7); // August
    expect(start.getHours()).toBe(0);
  });

  /** "This week" in a working context means since Monday. */
  test("a week starts on Monday", () => {
    // 2026-08-28 is a Friday.
    const start = periodStart("weekly", new Date("2026-08-28T15:00:00"))!;
    expect(start.getDay()).toBe(1);
    expect(start.getDate()).toBe(24);
  });

  test("Sunday belongs to the week that began the Monday before", () => {
    // 2026-08-30 is a Sunday; its week started Monday the 24th.
    const start = periodStart("weekly", new Date("2026-08-30T12:00:00"))!;
    expect(start.getDate()).toBe(24);
  });

  test("no period means no boundary", () => {
    expect(periodStart("none")).toBeNull();
  });
});

describe("periodResets", () => {
  test("reports when the current period rolls over", () => {
    const next = periodResets("monthly", new Date("2026-08-28T00:00:00"))!;
    expect(next.getMonth()).toBe(8); // September
    expect(next.getDate()).toBe(1);
  });

  test("a week rolls over seven days after it began", () => {
    const next = periodResets("weekly", new Date("2026-08-28T00:00:00"))!;
    expect(next.getDate()).toBe(31);
  });
});

describe("recordSpend", () => {
  test("prefers a figure the provider reported", () => {
    const handle = db();
    const usd = recordSpend(handle.raw, {
      provider: "claude-code",
      model: "claude-sonnet-5",
      stage: "score",
      inputTokens: 1000,
      outputTokens: 200,
      reportedUsd: 0.042,
    });
    expect(usd).toBe(0.042);
    const row = handle.raw
      .query<{ cost_source: string }, []>(`SELECT cost_source FROM ai_spend`)
      .get()!;
    expect(row.cost_source).toBe("reported");
    handle.close();
  });

  test("derives a cost from tokens when none was reported", () => {
    const handle = db();
    const usd = recordSpend(handle.raw, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      stage: "draft",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(usd).toBeCloseTo(3, 5); // $3/Mtok input
    handle.close();
  });

  /** Local models cost nothing, but the call is still logged so use is visible. */
  test("records a free provider at zero without pricing it", () => {
    const handle = db();
    const usd = recordSpend(handle.raw, {
      provider: "ollama",
      model: "llama3.1:8b",
      stage: "extract",
      inputTokens: 5000,
      outputTokens: 500,
    });
    expect(usd).toBe(0);
    const row = handle.raw.query<{ cost_source: string }, []>(`SELECT cost_source FROM ai_spend`).get()!;
    expect(row.cost_source).toBe("free");
    handle.close();
  });

  /**
   * An unknown model yields no figure rather than an invented one — a budget
   * built on a guessed price is worse than one that admits it cannot tell.
   */
  test("records zero for a model it has no price for, and flags it", () => {
    const handle = db();
    recordSpend(handle.raw, {
      provider: "openai",
      model: "some-model-shipped-next-year",
      stage: "score",
      inputTokens: 10_000,
      outputTokens: 2_000,
    });
    const summary = spendSince(handle.raw, null);
    expect(summary.total).toBe(0);
    expect(summary.unpriced).toBe(1);
    handle.close();
  });
});

describe("spendSince", () => {
  test("totals and groups by stage and model", () => {
    const handle = db();
    recordSpend(handle.raw, { provider: "anthropic", model: "claude-sonnet-5", stage: "score", reportedUsd: 1 });
    recordSpend(handle.raw, { provider: "anthropic", model: "claude-sonnet-5", stage: "score", reportedUsd: 2 });
    recordSpend(handle.raw, { provider: "openai", model: "gpt-4.1-mini", stage: "extract", reportedUsd: 0.5 });

    const summary = spendSince(handle.raw, null);
    expect(summary.total).toBeCloseTo(3.5, 5);
    expect(summary.calls).toBe(3);
    expect(summary.byStage[0]).toMatchObject({ stage: "score", usd: 3, calls: 2 });
    expect(summary.byModel.map((m) => m.model)).toContain("gpt-4.1-mini");
    handle.close();
  });

  test("counts only what falls inside the window", () => {
    const handle = db();
    handle.raw.run(
      `INSERT INTO ai_spend (at, provider, model, stage, estimated_usd, cost_source)
       VALUES (?, 'anthropic', 'claude-sonnet-5', 'score', 9.0, 'reported')`,
      [new Date(Date.now() - 60 * 86_400_000).toISOString()],
    );
    recordSpend(handle.raw, { provider: "anthropic", model: "claude-sonnet-5", stage: "score", reportedUsd: 1 });

    expect(spendSince(handle.raw, null).total).toBeCloseTo(10, 5);
    expect(spendSince(handle.raw, new Date(Date.now() - 86_400_000)).total).toBeCloseTo(1, 5);
    handle.close();
  });
});

describe("checkBudget", () => {
  const monthly = (limit: number) => ({ limit, period: "monthly" as const });

  test("permits a stage that fits", () => {
    const handle = db();
    const verdict = checkBudget(handle.raw, monthly(5), 1);
    expect(verdict.ok).toBe(true);
    expect(verdict.remaining).toBeCloseTo(5, 5);
    handle.close();
  });

  test("permits everything when the limit is zero", () => {
    const handle = db();
    expect(checkBudget(handle.raw, monthly(0), 9999).ok).toBe(true);
    handle.close();
  });

  test("permits everything when there is no period", () => {
    const handle = db();
    expect(checkBudget(handle.raw, { limit: 1, period: "none" }, 9999).ok).toBe(true);
    handle.close();
  });

  test("refuses when the limit is already spent", () => {
    const handle = db();
    recordSpend(handle.raw, { provider: "anthropic", model: "claude-sonnet-5", stage: "x", reportedUsd: 5 });
    const verdict = checkBudget(handle.raw, monthly(5), 0.01);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("Already spent");
    handle.close();
  });

  /** The projection is what makes stopping at a boundary possible. */
  test("refuses a stage that would cross the limit, before it starts", () => {
    const handle = db();
    recordSpend(handle.raw, { provider: "anthropic", model: "claude-sonnet-5", stage: "x", reportedUsd: 4 });
    const verdict = checkBudget(handle.raw, monthly(5), 3);
    expect(verdict.ok).toBe(false);
    expect(verdict.remaining).toBeCloseTo(1, 5);
    expect(verdict.reason).toContain("only");
    handle.close();
  });

  test("permits a stage that exactly fits what remains", () => {
    const handle = db();
    recordSpend(handle.raw, { provider: "anthropic", model: "claude-sonnet-5", stage: "x", reportedUsd: 4 });
    expect(checkBudget(handle.raw, monthly(5), 1).ok).toBe(true);
    handle.close();
  });
});

describe("pricing", () => {
  test("resolves a dated model id to its family price", () => {
    expect(priceFor("claude-sonnet-5-20260101")).toEqual(priceFor("claude-sonnet-5")!);
  });

  /** Longest prefix wins, or haiku would resolve as a generic claude model. */
  test("prefers the most specific price entry", () => {
    expect(priceFor("claude-haiku-4-5")!.input).toBeLessThan(priceFor("claude-opus-5")!.input);
  });

  test("returns nothing for a model it does not know", () => {
    expect(priceFor("mystery-model-9")).toBeNull();
    expect(estimateCost("mystery-model-9", 1000, 1000)).toBeNull();
  });

  test("prices input and output separately", () => {
    // Sonnet: $3 in, $15 out per million.
    expect(estimateCost("claude-sonnet-5", 1_000_000, 1_000_000)).toBeCloseTo(18, 5);
  });

  test("approximates tokens from length", () => {
    expect(approximateTokens("")).toBe(0);
    expect(approximateTokens("x".repeat(400))).toBe(100);
  });

  test("formats small amounts honestly rather than as zero", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0004)).toBe("<$0.01");
    expect(formatUsd(1.239)).toBe("$1.24");
  });
});
