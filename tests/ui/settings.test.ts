import { describe, expect, test } from "bun:test";
import { applySettings, settingsOptions } from "../../src/ui/settings.ts";
import { defaultConfig } from "../../src/config/schema.ts";

const base = () => defaultConfig();

describe("applySettings", () => {
  test("accepts a list as an array or a comma-separated string", () => {
    const a = applySettings(base(), { roles: ["backend engineer", " api engineer "] });
    const b = applySettings(base(), { roles: "backend engineer, api engineer" });
    expect(a.config!.search.roles).toEqual(["backend engineer", "api engineer"]);
    expect(b.config!.search.roles).toEqual(a.config!.search.roles);
  });

  test("drops blanks and repeats from a list", () => {
    const r = applySettings(base(), { roles: "backend, , backend, api" });
    expect(r.config!.search.roles).toEqual(["backend", "api"]);
  });

  /** An empty list is a real choice: it means do not filter. */
  test("allows clearing a list", () => {
    expect(applySettings(base(), { locations: "" }).config!.search.locations).toEqual([]);
  });

  test("reads a salary with separators, and blank as no floor", () => {
    expect(applySettings(base(), { salaryMin: "24,00,000" }).config!.search.salaryMin).toBe(2_400_000);
    expect(applySettings(base(), { salaryMin: "" }).config!.search.salaryMin).toBeNull();
  });

  test("refuses a salary that is not a number", () => {
    const r = applySettings(base(), { salaryMin: "lots" });
    expect(r.ok).toBe(false);
    expect(r.errors!.salaryMin).toContain("number");
  });

  test("refuses a currency that is not a three-letter code", () => {
    expect(applySettings(base(), { salaryCurrency: "rupees" }).ok).toBe(false);
    expect(applySettings(base(), { salaryCurrency: "inr" }).config!.search.salaryCurrency).toBe("INR");
  });

  test("keeps the threshold inside 0 and 1", () => {
    expect(applySettings(base(), { threshold: 0.4 }).config!.match.threshold).toBe(0.4);
    expect(applySettings(base(), { threshold: 2 }).ok).toBe(false);
    expect(applySettings(base(), { threshold: "high" }).ok).toBe(false);
  });

  test("refuses a provider that does not exist", () => {
    const r = applySettings(base(), { providers: ["claude-code", "gpt-9"] });
    expect(r.ok).toBe(false);
    expect(r.errors!.providers).toContain("gpt-9");
  });

  /** Order is the whole meaning of a chain. */
  test("preserves the order a chain was given in", () => {
    const r = applySettings(base(), { providers: ["ollama", "claude-code"] });
    expect(r.config!.ai.providers).toEqual(["ollama", "claude-code"]);
  });

  /** An empty chain means run without AI, which is supported. */
  test("allows an empty provider chain", () => {
    expect(applySettings(base(), { providers: [] }).config!.ai.providers).toEqual([]);
  });

  test("stores a budget, and blank as no limit", () => {
    expect(applySettings(base(), { budgetLimitUsd: "5" }).config!.ai.budget.limit).toBe(5);
    expect(applySettings(base(), { budgetLimitUsd: "" }).config!.ai.budget.limit).toBe(0);
    expect(applySettings(base(), { budgetLimitUsd: "-1" }).ok).toBe(false);
  });

  test("refuses an engine that does not exist, and an empty engine list", () => {
    expect(applySettings(base(), { engines: ["greenhouse", "monster"] }).errors!.engines)
      .toContain("monster");
    expect(applySettings(base(), { engines: [] }).ok).toBe(false);
  });

  test("leaves fields the patch does not mention alone", () => {
    const before = base();
    const after = applySettings(before, { roles: "backend" }).config!;
    expect(after.engines.enabled).toEqual(before.engines.enabled);
    expect(after.ai.providers).toEqual(before.ai.providers);
  });

  /** A rejected edit must leave nothing half-applied for the caller to save. */
  test("returns no config at all when anything is wrong", () => {
    const r = applySettings(base(), { roles: "backend", threshold: 9 });
    expect(r.ok).toBe(false);
    expect(r.config).toBeUndefined();
  });

  test("reports every bad field at once, not just the first", () => {
    const r = applySettings(base(), { threshold: 9, salaryCurrency: "x", providers: ["nope"] });
    expect(Object.keys(r.errors!).sort()).toEqual(["providers", "salaryCurrency", "threshold"]);
  });
});

describe("settingsOptions", () => {
  test("offers the real providers and engines, so a form cannot invent one", () => {
    const o = settingsOptions();
    expect(o.providers).toContain("claude-code");
    expect(o.engines).toContain("greenhouse");
    expect(o.budgetPeriods).toEqual(["weekly", "monthly", "none"]);
  });
});
