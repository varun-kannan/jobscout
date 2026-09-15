import { describe, expect, test } from "bun:test";
import {
  parseList,
  parseSalary,
  describePreferences,
  preferencesCheck,
} from "../../src/setup/checks/preferences.ts";
import { defaultConfig, type Config } from "../../src/config/schema.ts";
import type { CheckContext } from "../../src/setup/checks/check.ts";

function withSearch(search: Partial<Config["search"]>): Config {
  const base = defaultConfig();
  return { ...base, search: { ...base.search, ...search } };
}

function ctxFor(config: Config, assumeYes = false): CheckContext {
  return { config, assumeYes } as unknown as CheckContext;
}

/** Run with stdin reporting a terminal, so a fix may ask questions. */
async function asTerminal<T>(fn: () => Promise<T>): Promise<T> {
  const before = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  try {
    return await fn();
  } finally {
    if (before) Object.defineProperty(process.stdin, "isTTY", before);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
}

describe("parseList", () => {
  test("splits, trims, and drops blanks", () => {
    expect(parseList(" backend engineer , payments ,, ")).toEqual([
      "backend engineer",
      "payments",
    ]);
  });

  test("an empty answer is an empty list, not [\"\"]", () => {
    expect(parseList("")).toEqual([]);
    expect(parseList("   ,  , ")).toEqual([]);
  });

  test("does not repeat a value typed twice", () => {
    expect(parseList("backend, backend")).toEqual(["backend"]);
  });
});

describe("parseSalary", () => {
  /** People type what they say out loud, so the unit has to be understood. */
  test("reads the shorthands people actually use", () => {
    expect(parseSalary("120k")).toBe(120_000);
    expect(parseSalary("$120K")).toBe(120_000);
    expect(parseSalary("1.5m")).toBe(1_500_000);
    expect(parseSalary("90000")).toBe(90_000);
    expect(parseSalary("80 000")).toBe(80_000);
    expect(parseSalary("12,00,000")).toBe(1_200_000);
  });

  /** Indian postings are quoted in lakhs and said as "24 LPA". */
  test("understands lakhs", () => {
    expect(parseSalary("24 LPA")).toBe(2_400_000);
    expect(parseSalary("12l")).toBe(1_200_000);
  });

  test("blank means no minimum, which is a real choice", () => {
    expect(parseSalary("")).toBeNull();
    expect(parseSalary("   ")).toBeNull();
  });

  test("refuses what it cannot read rather than guessing a number", () => {
    expect(parseSalary("negotiable")).toBeNull();
    expect(parseSalary("100-200k")).toBeNull();
  });
});

describe("describePreferences", () => {
  test("says plainly when nothing is set", () => {
    expect(describePreferences(withSearch({}))).toBe("no roles, no locations");
  });

  test("counts what is set and names the floor", () => {
    const text = describePreferences(
      withSearch({
        roles: ["backend engineer"],
        locations: ["Remote", "Bengaluru"],
        remoteOnly: true,
        salaryMin: 120_000,
        salaryCurrency: "USD",
      }),
    );
    expect(text).toContain("1 role(s)");
    expect(text).toContain("2 location(s)");
    expect(text).toContain("remote only");
    expect(text).toContain("USD 120,000");
  });
});

describe("the preferences check", () => {
  /**
   * An empty set is not a neutral default, engines keep everything, so this
   * has to be visible on a first run rather than silently accepted.
   */
  test("warns when nothing is set, and offers to fix it in a terminal", async () => {
    const result = await asTerminal(() => preferencesCheck.run(ctxFor(withSearch({}))));
    expect(result.state).toBe("warn");
    expect(result.summary).toContain("every posting is kept");
    expect(result.fix).toBeDefined();
  });

  /** Offering a fix under `--yes` made `init --yes` stop on the first question. */
  test("offers no fix under --yes, only how to set them later", async () => {
    const result = await asTerminal(() => preferencesCheck.run(ctxFor(withSearch({}), true)));
    expect(result.state).toBe("warn");
    expect(result.fix).toBeUndefined();
    expect(result.detail!.join(" ")).toContain("jobscout init");
  });

  test("offers no fix when nothing is attached to a terminal", async () => {
    const result = await preferencesCheck.run(ctxFor(withSearch({})));
    expect(result.fix).toBeUndefined();
  });

  /** A location alone still returns every function in that city. */
  test("still warns when only locations are set", async () => {
    const result = await preferencesCheck.run(ctxFor(withSearch({ locations: ["Bengaluru"] })));
    expect(result.state).toBe("warn");
    expect(result.summary).toContain("no roles set");
  });

  test("passes once roles are set", async () => {
    const result = await preferencesCheck.run(
      ctxFor(withSearch({ roles: ["backend engineer"], locations: ["Remote"] })),
    );
    expect(result.state).toBe("ok");
    expect(result.fix).toBeUndefined();
  });

  /** It never blocks a run: unfiltered search still works. */
  test("never reports a failure", async () => {
    for (const search of [{}, { locations: ["X"] }, { roles: ["Y"] }]) {
      const result = await preferencesCheck.run(ctxFor(withSearch(search)));
      expect(result.state).not.toBe("fail");
    }
  });
});
