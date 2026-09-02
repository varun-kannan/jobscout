/**
 * Ordered migration steps.
 *
 * Each step is applied exactly once, in order, to any database below its
 * version. A fresh database runs all of them; an existing one runs only what it
 * has not seen.
 *
 * This replaced a single schema.sql applied wholesale with IF NOT EXISTS
 * everywhere. That worked for added *tables* but broke on added *columns*: the
 * existing table was left alone, and the first index referencing a new column
 * failed with "no such column". Numbered steps make each change explicit and
 * let a step use ALTER TABLE where it needs to.
 *
 * To add a change: create NNN_name.sql, import it, append it below. Nothing
 * else needs updating — SCHEMA_VERSION is derived from this list.
 */

import m001 from "./001_initial.sql" with { type: "text" };
import m002 from "./002_signals.sql" with { type: "text" };
import m003 from "./003_skill_source.sql" with { type: "text" };
import m004 from "./004_ai_spend.sql" with { type: "text" };

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial", sql: m001 },
  { version: 2, name: "signals", sql: m002 },
  { version: 3, name: "skill-source", sql: m003 },
  { version: 4, name: "ai-spend", sql: m004 },
];

/** The version a fully migrated database reports. */
export const LATEST_VERSION: number = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);
