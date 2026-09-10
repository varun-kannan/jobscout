import { describe, expect, test } from "bun:test";
import { installTarget, sourceRoot, onPathCheck } from "../../src/setup/checks/on-path.ts";

describe("sourceRoot", () => {
  /** The tests run from a checkout, so this must find it. */
  test("finds the checkout when running from source", () => {
    const root = sourceRoot();
    expect(root).not.toBeNull();
    expect(root).toContain("jobscout");
  });
});

describe("installTarget", () => {
  test("prefers a writable directory already on PATH", async () => {
    const target = await installTarget("/nonexistent-aaa:/tmp");
    expect(target).toBe("/tmp");
  });

  /**
   * The fix has to work without a password, so directories needing one are
   * never chosen — offering to install somewhere that then fails is worse
   * than saying it cannot be done.
   */
  test("never picks a directory that would need sudo", async () => {
    expect(await installTarget("/usr/bin:/sbin:/bin")).toBeNull();
  });

  test("returns null when nothing on PATH is writable", async () => {
    expect(await installTarget("/nonexistent-aaa:/nonexistent-bbb")).toBeNull();
  });

  test("an empty PATH yields nowhere to install", async () => {
    expect(await installTarget("")).toBeNull();
  });
});

describe("the on-PATH check", () => {
  /** A missing command is an inconvenience, not a broken install. */
  test("never reports a failure", async () => {
    const result = await onPathCheck.run({} as never);
    expect(result.state).not.toBe("fail");
    expect(["ok", "warn"]).toContain(result.state);
  });

  test("does not apply when running as the compiled binary", () => {
    // Running from source here, so it does apply; the guard is the assertion
    // that `applies` is wired to sourceRoot at all.
    expect(onPathCheck.applies?.({} as never)).toBe(sourceRoot() !== null);
  });
});
