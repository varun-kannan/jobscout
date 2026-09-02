/**
 * Database connection and migrations.
 *
 * Migration steps live in migrations/ and are embedded into the compiled
 * binary, so a released executable carries its own schema with no files
 * alongside it.
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { LATEST_VERSION, MIGRATIONS, type Migration } from "./migrations/index.ts";

/** Derived from the migration list — never edit this by hand. */
export const SCHEMA_VERSION = LATEST_VERSION;

export interface DbHandle {
  raw: Database;
  close(): void;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: Migration[];
}

export async function openDb(path: string): Promise<DbHandle> {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  return { raw: db, close: () => db.close() };
}

/** In-memory database, used by the test suite. WAL does not apply. */
export function openMemoryDb(): DbHandle {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return { raw: db, close: () => db.close() };
}

export function currentVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

/**
 * Apply every migration the database has not seen, in order.
 *
 * Each step runs in its own transaction and stamps its own version, so a
 * failure part-way through a chain leaves the database at the last version that
 * fully succeeded rather than in a half-migrated state.
 */
export function migrate(db: Database): MigrateResult {
  const from = currentVersion(db);

  if (from > SCHEMA_VERSION) {
    throw new Error(
      `Database schema is version ${from}, but this build of jobscout only understands ${SCHEMA_VERSION}. ` +
        `Update jobscout, or point JOBSCOUT_HOME at a different directory.`,
    );
  }

  const pending = MIGRATIONS.filter((m) => m.version > from).sort(
    (a, b) => a.version - b.version,
  );

  const applied: Migration[] = [];
  for (const step of pending) {
    try {
      db.transaction(() => {
        db.exec(step.sql);
        db.exec(`PRAGMA user_version = ${step.version}`);
      })();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Migration ${step.version} (${step.name}) failed: ${reason}. ` +
          `The database is still at version ${currentVersion(db)}.`,
      );
    }
    applied.push(step);
  }

  return { from, to: currentVersion(db), applied };
}

/** Open and migrate in one step — what every command does at startup. */
export async function openAndMigrate(path: string): Promise<DbHandle> {
  const handle = await openDb(path);
  migrate(handle.raw);
  return handle;
}
