/**
 * What a call costs, approximately.
 *
 * Every figure here is an estimate and is treated as one. Two reasons:
 *
 *   - This table goes stale. Providers change prices, and a stale table
 *     enforces the wrong budget silently, which is worse than no budget.
 *   - Even a provider's own number can be approximate. Claude Code reports
 *     `total_cost_usd`, but its documentation calls that a client-side
 *     estimate that "can differ from your actual bill".
 *
 * So costs are recorded with their provenance — `reported` when the provider
 * told us, `derived` when computed from this table — and the budget is
 * described as estimated spend everywhere it is shown.
 *
 * Prices are US dollars per million tokens. Update `PRICES_UPDATED` when
 * changing them, so a stale table can be spotted rather than trusted.
 */

export const PRICES_UPDATED = "2026-08-28";

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

/**
 * Keyed by a prefix of the model id, longest match first, so a dated variant
 * like `claude-sonnet-5-20260101` resolves without a new entry per release.
 */
const PRICES: Array<[string, ModelPrice]> = [
  // Anthropic
  ["claude-opus-5", { input: 15, output: 75 }],
  ["claude-sonnet-5", { input: 3, output: 15 }],
  ["claude-haiku-4-5", { input: 1, output: 5 }],
  ["claude-3-5-haiku", { input: 0.8, output: 4 }],

  // OpenAI
  ["gpt-5", { input: 1.25, output: 10 }],
  ["gpt-4.1-mini", { input: 0.4, output: 1.6 }],
  ["gpt-4.1", { input: 2, output: 8 }],
  ["o4-mini", { input: 1.1, output: 4.4 }],

  // Google
  ["gemini-2.5-pro", { input: 1.25, output: 10 }],
  ["gemini-2.5-flash", { input: 0.3, output: 2.5 }],
  ["gemini-2.0-flash", { input: 0.1, output: 0.4 }],
];

/** Local models cost nothing to call. */
export function isFreeProvider(provider: string): boolean {
  return provider === "ollama" || provider === "none";
}

export function priceFor(model: string): ModelPrice | null {
  const id = model.toLowerCase();
  const match = PRICES.filter(([prefix]) => id.startsWith(prefix)).sort(
    (a, b) => b[0].length - a[0].length,
  )[0];
  return match?.[1] ?? null;
}

/**
 * Estimated cost of a call, in USD.
 *
 * Returns null for an unknown model rather than guessing a price — a budget
 * built on an invented number is worse than one that admits it cannot tell.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = priceFor(model);
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

/**
 * A rough token count, for estimating a stage before running it.
 *
 * Deliberately crude — roughly four characters per token holds well enough
 * across English prose to size a budget check, and pulling in a real tokeniser
 * for every provider would cost more than the accuracy is worth here.
 */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Human-readable cost, honest about small numbers. */
export function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}
