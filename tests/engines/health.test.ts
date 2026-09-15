import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "../../src/db/migrations/index.ts";
import { engineHealth, lastDiscoveryAt } from "../../src/engines/health.ts";
import { defaultConfig, type Config } from "../../src/config/schema.ts";

function database(): Database {
  const db = new Database(":memory:");
  for (const step of MIGRATIONS) db.exec(step.sql);
  return db;
}

function withEngines(enabled: string[]): Config {
  const config = defaultConfig();
  return { ...config, engines: { enabled: enabled as Config["engines"]["enabled"] } };
}

const byId = <T extends { id: string }>(rows: T[], id: string) => rows.find((r) => r.id === id)!;

describe("engineHealth", () => {
  test("an enabled keyless engine is ready", async () => {
    const rows = await engineHealth({
      db: database(), config: withEngines(["remoteok"]), secrets: {}, boards: [],
    });
    expect(byId(rows, "remoteok")).toMatchObject({ enabled: true, ready: true, blockedBy: null });
  });

  test("a disabled engine is neither ready nor blocked", async () => {
    const rows = await engineHealth({
      db: database(), config: withEngines(["remoteok"]), secrets: {}, boards: [],
    });
    expect(byId(rows, "lever")).toMatchObject({ enabled: false, ready: false, blockedBy: null });
  });

  /** Enabled in Setup but silently skipped at runtime was the original complaint. */
  test("an engine enabled without its key says what is missing", async () => {
    const rows = await engineHealth({
      db: database(), config: withEngines(["adzuna"]), secrets: {}, boards: [],
    });
    const adzuna = byId(rows, "adzuna");
    expect(adzuna.ready).toBe(false);
    expect(adzuna.blockedBy).toContain("Adzuna");
  });

  test("the key makes it ready", async () => {
    const rows = await engineHealth({
      db: database(), config: withEngines(["adzuna"]),
      secrets: { adzuna: { appId: "id", appKey: "key" } }, boards: [],
    });
    expect(byId(rows, "adzuna").ready).toBe(true);
  });

  /** `doctor` calls this ready; discovery skips it. This report follows discovery. */
  test("an ATS engine with no boards is blocked, as discovery would find it", async () => {
    const rows = await engineHealth({
      db: database(), config: withEngines(["workable"]), secrets: {}, boards: [],
    });
    expect(byId(rows, "workable").ready).toBe(false);
    expect(byId(rows, "workable").blockedBy).toContain("boards");
  });

  test("an ATS engine only counts boards for its own platform", async () => {
    const rows = await engineHealth({
      db: database(), config: withEngines(["workable"]), secrets: {},
      boards: [{ company: "Acme", ats: "greenhouse", token: "acme" } as never],
    });
    expect(byId(rows, "workable").ready).toBe(false);
  });

  /** JobSpy's own ready() only checks it is enabled, then fails at runtime. */
  test("JobSpy is blocked when the Python check fails", async () => {
    const rows = await engineHealth({
      db: database(), config: withEngines(["jobspy"]), secrets: {}, boards: [],
      pythonStatus: async () => ({ ok: false, reason: "python3 3.9 is too old" }),
    });
    expect(byId(rows, "jobspy")).toMatchObject({ ready: false, blockedBy: "python3 3.9 is too old" });
  });

  test("Python is not checked at all when JobSpy is off", async () => {
    let asked = false;
    await engineHealth({
      db: database(), config: withEngines(["remoteok"]), secrets: {}, boards: [],
      pythonStatus: async () => {
        asked = true;
        return { ok: true, reason: "" };
      },
    });
    expect(asked).toBe(false);
  });

  test("reports the latest run and the stored job count", async () => {
    const db = database();
    const run = db.prepare(`INSERT INTO engine_runs (engine, started_at, finished_at, status, fetched, inserted, error)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`);
    run.run("remoteok", "2026-09-01T00:00:00Z", "2026-09-01T00:00:05Z", "ok", 20, 5, null);
    run.run("remoteok", "2026-09-10T00:00:00Z", "2026-09-10T00:00:05Z", "error", 0, 0, "timed out");
    db.prepare(`INSERT INTO jobs (id, engine, native_id, company, title, first_seen, last_seen)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run("j1", "remoteok", "n", "C", "T", "2026-09-01", "2026-09-01");

    const rows = await engineHealth({ db, config: withEngines(["remoteok"]), secrets: {}, boards: [] });
    const remoteok = byId(rows, "remoteok");
    expect(remoteok.lastRun).toMatchObject({ status: "error", error: "timed out" });
    expect(remoteok.jobs).toBe(1);
    expect(lastDiscoveryAt(db)).toBe("2026-09-10T00:00:00Z");
  });

  test("an engine that has never run has no last run", async () => {
    const db = database();
    const rows = await engineHealth({ db, config: withEngines(["remoteok"]), secrets: {}, boards: [] });
    expect(byId(rows, "remoteok").lastRun).toBeNull();
    expect(lastDiscoveryAt(db)).toBeNull();
  });
});
