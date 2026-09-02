/**
 * Tracking what the AI has cost, and refusing to spend past a limit.
 *
 * The limit is enforced at *stage boundaries*, never mid-stage. Stopping in the
 * middle of drafting would leave some jobs written and others not, with no
 * record of which — so a stage that would cross the limit is not started at
 * all, and the run stops with nothing half-written.
 *
 * Everything here deals in estimates and says so. See pricing.ts.
 */

import type { Database } from "bun:sqlite";
import { estimateCost, formatUsd, isFreeProvider } from "./pricing.ts";

export const BUDGET_PERIODS = ["weekly", "monthly", "none"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export type CostSource = "reported" | "derived" | "free";

export interface SpendRecord {
  provider: string;
  model: string;
  stage: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Present when the provider reported a figure itself. */
  reportedUsd?: number;
}

/**
 * The inclusive start of the current budget period.
 *
 * Weeks start Monday, which is what a person means by "this week" in a working
 * context. Months start on the 1st, matching how API billing actually works.
 */
export function periodStart(period: BudgetPeriod, now: Date = new Date()): Date | null {
  if (period === "none") return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  if (period === "monthly") {
    start.setDate(1);
    return start;
  }

  // getDay() is 0 for Sunday; shift so Monday is the first day.
  const dayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - dayOffset);
  return start;
}

/** Record one call. Free providers are logged too, so usage stays visible. */
export function recordSpend(db: Database, record: SpendRecord): number {
  const free = isFreeProvider(record.provider);

  let usd = 0;
  let source: CostSource = "derived";

  if (free) {
    source = "free";
  } else if (record.reportedUsd !== undefined) {
    usd = record.reportedUsd;
    source = "reported";
  } else {
    const derived = estimateCost(
      record.model,
      record.inputTokens ?? 0,
      record.outputTokens ?? 0,
    );
    // An unknown model yields no figure rather than an invented one.
    usd = derived ?? 0;
  }

  db.prepare(`
    INSERT INTO ai_spend (at, provider, model, stage, input_tokens, output_tokens, estimated_usd, cost_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    record.provider,
    record.model,
    record.stage,
    record.inputTokens ?? null,
    record.outputTokens ?? null,
    usd,
    source,
  );

  return usd;
}

export interface SpendSummary {
  total: number;
  calls: number;
  /** Calls whose cost could not be derived — the estimate understates by this. */
  unpriced: number;
  byStage: Array<{ stage: string; usd: number; calls: number }>;
  byModel: Array<{ model: string; usd: number; calls: number }>;
}

export function spendSince(db: Database, since: Date | null): SpendSummary {
  const where = since ? `WHERE at >= ?` : ``;
  const params: string[] = since ? [since.toISOString()] : [];

  const totals = db
    .query<{ total: number | null; calls: number; unpriced: number }, string[]>(
      `SELECT SUM(estimated_usd) AS total, COUNT(*) AS calls,
              SUM(CASE WHEN estimated_usd = 0 AND cost_source = 'derived' THEN 1 ELSE 0 END) AS unpriced
       FROM ai_spend ${where}`,
    )
    .get(...params);

  const byStage = db
    .query<{ stage: string; usd: number; calls: number }, string[]>(
      `SELECT stage, SUM(estimated_usd) AS usd, COUNT(*) AS calls
       FROM ai_spend ${where} GROUP BY stage ORDER BY usd DESC`,
    )
    .all(...params);

  const byModel = db
    .query<{ model: string; usd: number; calls: number }, string[]>(
      `SELECT model, SUM(estimated_usd) AS usd, COUNT(*) AS calls
       FROM ai_spend ${where} GROUP BY model ORDER BY usd DESC`,
    )
    .all(...params);

  return {
    total: totals?.total ?? 0,
    calls: totals?.calls ?? 0,
    unpriced: totals?.unpriced ?? 0,
    byStage,
    byModel,
  };
}

export interface BudgetConfig {
  /** USD. Zero or negative means no limit. */
  limit: number;
  period: BudgetPeriod;
}

export interface BudgetVerdict {
  /** May the stage proceed? */
  ok: boolean;
  spent: number;
  limit: number;
  remaining: number;
  /** What the stage about to run is expected to cost. */
  projected: number;
  reason?: string;
}

/**
 * Decide whether a stage may run.
 *
 * Checked before the stage starts, with the stage's whole projected cost, so a
 * run either does a stage completely or does not begin it.
 */
export function checkBudget(
  db: Database,
  config: BudgetConfig,
  projected: number,
  now: Date = new Date(),
): BudgetVerdict {
  const unlimited = config.limit <= 0 || config.period === "none";
  const spent = spendSince(db, periodStart(config.period, now)).total;
  const remaining = Math.max(0, config.limit - spent);

  if (unlimited) {
    return { ok: true, spent, limit: config.limit, remaining: Infinity, projected };
  }

  if (spent >= config.limit) {
    return {
      ok: false,
      spent,
      limit: config.limit,
      remaining: 0,
      projected,
      reason: `Already spent ${formatUsd(spent)} of your ${formatUsd(config.limit)} ${config.period} limit.`,
    };
  }

  if (projected > remaining) {
    return {
      ok: false,
      spent,
      limit: config.limit,
      remaining,
      projected,
      reason:
        `This stage is estimated at ${formatUsd(projected)}, but only ` +
        `${formatUsd(remaining)} of your ${formatUsd(config.limit)} ${config.period} limit is left.`,
    };
  }

  return { ok: true, spent, limit: config.limit, remaining, projected };
}

/** When the current period rolls over, for telling the user when it resets. */
export function periodResets(period: BudgetPeriod, now: Date = new Date()): Date | null {
  const start = periodStart(period, now);
  if (!start) return null;
  const next = new Date(start);
  if (period === "monthly") next.setMonth(next.getMonth() + 1);
  else next.setDate(next.getDate() + 7);
  return next;
}
