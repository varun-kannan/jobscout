import { describe, expect, test } from "bun:test";
import { DiscoveryJob, type DiscoverRunner } from "../../src/ui/discovery-job.ts";
import type { EngineRun } from "../../src/engines/registry.ts";

function run(engine: string, fetched: number, status = "ok", error?: string): EngineRun {
  return {
    engine: engine as EngineRun["engine"],
    status: status as EngineRun["status"],
    startedAt: "2026-09-15T00:00:00Z",
    finishedAt: "2026-09-15T00:00:01Z",
    fetched,
    jobs: [],
    error,
  };
}

/** A runner the test finishes by hand, so "still running" can be observed. */
function controllable() {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  const runner: DiscoverRunner = async (onFinish) => {
    onFinish(run("greenhouse", 10), 4);
    await gate;
    onFinish(run("lever", 5), 1);
  };
  return { runner, finish };
}

describe("DiscoveryJob", () => {
  test("starts idle", () => {
    const job = new DiscoveryJob(async () => {});
    expect(job.state().running).toBe(false);
    expect(job.state().startedAt).toBeNull();
  });

  test("reports engines as they land, before the pass ends", async () => {
    const { runner, finish } = controllable();
    const job = new DiscoveryJob(runner);
    job.start();
    await Promise.resolve();

    const midway = job.state();
    expect(midway.running).toBe(true);
    expect(midway.engines.map((e) => e.engine)).toEqual(["greenhouse"]);

    finish();
    await job.settled();
    expect(job.state().engines.map((e) => e.engine)).toEqual(["greenhouse", "lever"]);
  });

  test("totals fetched and inserted across engines", async () => {
    const { runner, finish } = controllable();
    const job = new DiscoveryJob(runner);
    job.start();
    finish();
    await job.settled();
    expect(job.state().fetched).toBe(15);
    expect(job.state().inserted).toBe(5);
  });

  /** Two passes at once would poll the same boards twice and race on rows. */
  test("refuses to start a second pass while one is running", async () => {
    const { runner, finish } = controllable();
    let calls = 0;
    const job = new DiscoveryJob(async (onFinish) => {
      calls++;
      await runner(onFinish);
    });
    expect(job.start()).toBe(true);
    expect(job.start()).toBe(false);
    finish();
    await job.settled();
    expect(calls).toBe(1);
  });

  test("can start again once the previous pass has finished", async () => {
    const job = new DiscoveryJob(async () => {});
    job.start();
    await job.settled();
    expect(job.start()).toBe(true);
    await job.settled();
  });

  test("ranks new postings after discovery and reports how many", async () => {
    const job = new DiscoveryJob(async () => {}, () => 42);
    job.start();
    await job.settled();
    expect(job.state().ranked).toBe(42);
  });

  /** A failed pass must end, not leave the button stuck on "running". */
  test("records a failure and stops running", async () => {
    const job = new DiscoveryJob(async () => {
      throw new Error("network down");
    });
    job.start();
    await job.settled();
    expect(job.state().running).toBe(false);
    expect(job.state().error).toBe("network down");
    expect(job.state().finishedAt).not.toBeNull();
  });

  test("keeps an engine's own error with its row", async () => {
    const job = new DiscoveryJob(async (onFinish) => {
      onFinish(run("ashby", 0, "rate_limited", "HTTP 429"), 0);
    });
    job.start();
    await job.settled();
    expect(job.state().engines[0]).toMatchObject({ status: "rate_limited", error: "HTTP 429" });
  });

  test("a new pass clears the previous pass's results", async () => {
    let first = true;
    const job = new DiscoveryJob(async (onFinish) => {
      if (first) onFinish(run("greenhouse", 10), 4);
      first = false;
    });
    job.start();
    await job.settled();
    job.start();
    await job.settled();
    expect(job.state().engines).toEqual([]);
    expect(job.state().fetched).toBe(0);
  });
});
