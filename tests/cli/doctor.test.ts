import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/setup/init.ts";
import { doctorCommand } from "../../src/cli/doctor.ts";
import { openDb, openAndMigrate, openReadOnly, currentVersion, SCHEMA_VERSION } from "../../src/db/db.ts";
import { MIGRATIONS } from "../../src/db/migrations/index.ts";

/** Run with stdout silenced — the report is the thing under test, not output noise. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = write;
  }
}

async function tempRoot(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "jobscout-doctor-")), "home");
}

describe("doctor", () => {
  test("is declared, and takes no flag that could change anything", () => {
    expect(doctorCommand.meta).toMatchObject({ name: "doctor" });
    // Only --root. A report that could enable engines or install a backend
    // would not be a report.
    expect(Object.keys(doctorCommand.args ?? {})).toEqual(["root"]);
  });

  /**
   * The reason `doctor` delegates instead of holding its own checks: two
   * implementations drift, and then one calls an install healthy while the
   * other calls it broken. Identical outcomes prove they share the registry.
   */
  test("reports exactly what init --dry-run reports", async () => {
    const root = await tempRoot();
    try {
      const asDoctor = await quiet(() =>
        runInit({ root, assumeYes: true, dryRun: true, repair: false, all: false, noAi: false, label: "doctor" }),
      );
      const asInit = await quiet(() =>
        runInit({ root, assumeYes: true, dryRun: true, repair: false, all: false, noAi: false }),
      );
      expect(asDoctor).toEqual(asInit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("creates nothing at all", async () => {
    const root = await tempRoot();
    try {
      await quiet(() =>
        runInit({ root, assumeYes: true, dryRun: true, repair: false, all: false, noAi: false, label: "doctor" }),
      );
      // Not even the data directory, which a real init would create first.
      expect(existsSync(root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /** Non-zero exit is what makes it usable in a script or CI. */
  test("reports a fresh machine as not ready", async () => {
    const root = await tempRoot();
    try {
      const outcome = await quiet(() =>
        runInit({ root, assumeYes: true, dryRun: true, repair: false, all: false, noAi: false, label: "doctor" }),
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.failures).toBeGreaterThan(0);
      // A report never repairs, whatever it finds.
      expect(outcome.fixesApplied).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * `openDb` creates missing directories, creates the file, and sets
 * `journal_mode = WAL` — three writes before a row is read. A report that used
 * it brought into being the very database it was checking for.
 */
describe("a report never writes to the database", () => {
  test("does not create it, even when the data directory exists", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });
    try {
      await quiet(() =>
        runInit({ root, assumeYes: true, dryRun: true, repair: false, all: false, noAi: false, label: "doctor" }),
      );
      expect(existsSync(join(root, "jobscout.db"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports an out-of-date schema without migrating it", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });
    const dbPath = join(root, "jobscout.db");
    try {
      // A genuinely old database — steps 1 and 2 only, so 3 and 4 really can
      // still be applied. Stamping a *modern* schema with an old version
      // number instead makes migration fail on a duplicate column, and then
      // "still v2" passes for the wrong reason whether or not the guard works.
      const old = await openDb(dbPath);
      for (const step of MIGRATIONS.filter((m) => m.version <= 2)) {
        old.raw.exec(step.sql);
        old.raw.exec(`PRAGMA user_version = ${step.version}`);
      }
      expect(currentVersion(old.raw)).toBe(2);
      old.close();

      await quiet(() =>
        runInit({ root, assumeYes: true, dryRun: true, repair: false, all: false, noAi: false, label: "doctor" }),
      );

      const after = openReadOnly(dbPath);
      expect(currentVersion(after.raw)).toBe(2);
      after.close();

      // And prove it was migratable the whole time, so holding at v2 above
      // shows the report refrained rather than that it could not have.
      const real = await openAndMigrate(dbPath);
      expect(currentVersion(real.raw)).toBe(SCHEMA_VERSION);
      real.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
