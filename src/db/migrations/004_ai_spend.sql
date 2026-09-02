-- v4 — AI provider routing and spend tracking.
--
-- Every AI call records what it cost, so a budget can be enforced and so the
-- estimate can be audited against a real invoice. The figures are estimates:
-- Claude Code's own `total_cost_usd` is documented as client-side, and API
-- costs are derived from a price table that goes stale. Nothing here is
-- presented as a guarantee.

CREATE TABLE IF NOT EXISTS ai_spend (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  -- Which pipeline stage spent this, so cost can be attributed to the work.
  stage          TEXT NOT NULL,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  estimated_usd  REAL NOT NULL DEFAULT 0,
  -- 'reported' when the provider told us, 'derived' when computed from a
  -- price table. Only the first is worth trusting closely.
  cost_source    TEXT NOT NULL DEFAULT 'derived'
                   CHECK (cost_source IN ('reported', 'derived', 'free'))
);

CREATE INDEX IF NOT EXISTS idx_ai_spend_at ON ai_spend(at);
CREATE INDEX IF NOT EXISTS idx_ai_spend_stage ON ai_spend(stage);
