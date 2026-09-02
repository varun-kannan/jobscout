import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPaths, expand } from "../../src/config/paths.ts";
import {
  ConfigError,
  loadConfig,
  loadSecrets,
  saveConfig,
  saveSecrets,
} from "../../src/config/load.ts";
import { configSchema, defaultConfig, KEYLESS_ENGINES, PAID_PROVIDERS } from "../../src/config/schema.ts";

const temps: string[] = [];

async function tempPaths() {
  const dir = await mkdtemp(join(tmpdir(), "jobscout-test-"));
  temps.push(dir);
  return buildPaths(dir);
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("paths", () => {
  test("expands a leading tilde", () => {
    expect(expand("~/jobscout")).toMatch(/^\/.*\/jobscout$/);
    expect(expand("~/jobscout")).not.toContain("~");
  });

  test("keeps absolute paths intact", () => {
    expect(expand("/var/tmp/x")).toBe("/var/tmp/x");
  });

  test("derives every path from one root", () => {
    const p = buildPaths("/data/js");
    expect(p.db).toBe("/data/js/jobscout.db");
    expect(p.secrets).toBe("/data/js/secrets.toml");
    expect(p.skills).toBe("/data/js/profile/skills.toml");
  });
});

describe("config defaults", () => {
  test("enables exactly the keyless engines", () => {
    const cfg = defaultConfig();
    expect(cfg.engines.enabled).toEqual([...KEYLESS_ENGINES]);
    expect(cfg.engines.enabled).toHaveLength(15);
  });

  test("defaults to the free CLI chain, Claude Code first", () => {
    const ai = defaultConfig().ai;
    expect(ai.providers[0]).toBe("claude-code");
    expect(ai.providers).toContain("ollama");
  });

  /** The default must never be able to spend money without being asked. */
  test("no paid provider appears in the defaults", () => {
    const ai = defaultConfig().ai;
    for (const paid of PAID_PROVIDERS) expect(ai.providers).not.toContain(paid);
  });

  test("defaults to no spend limit, because nothing paid is on", () => {
    expect(defaultConfig().ai.budget.limit).toBe(0);
    expect(defaultConfig().ai.budget.period).toBe("monthly");
  });

  test("match weights sum to one", () => {
    const m = defaultConfig().match;
    const sum = m.requiredCoverage + m.preferredCoverage + m.seniorityFit + m.domainAffinity;
    expect(sum).toBeCloseTo(1, 6);
  });

  test("rejects weights that do not sum to one", () => {
    const bad = configSchema.safeParse({
      match: {
        requiredCoverage: 0.9,
        preferredCoverage: 0.9,
        seniorityFit: 0.1,
        domainAffinity: 0.1,
      },
    });
    expect(bad.success).toBe(false);
  });
});

describe("config round-trip", () => {
  test("returns null when nothing has been written", async () => {
    const paths = await tempPaths();
    expect(await loadConfig(paths)).toBeNull();
  });

  test("saves and reloads without losing values", async () => {
    const paths = await tempPaths();
    const cfg = defaultConfig();
    cfg.search.roles = ["senior backend", "payments"];
    cfg.search.salaryCurrency = "INR";
    cfg.search.salaryMin = 2_000_000;
    cfg.profile.resumeFile = "~/Documents/cv.pdf";

    await saveConfig(paths, cfg);
    const back = await loadConfig(paths);

    expect(back?.search.roles).toEqual(["senior backend", "payments"]);
    expect(back?.search.salaryCurrency).toBe("INR");
    expect(back?.search.salaryMin).toBe(2_000_000);
    expect(back?.profile.resumeFile).toBe("~/Documents/cv.pdf");
  });

  /**
   * Keys are reported rather than dropped. `provider` was renamed to
   * `providers`; silently ignoring the old name would leave a hand-edited
   * config doing nothing with no explanation.
   */
  test("reports an unknown key instead of silently ignoring it", async () => {
    const paths = await tempPaths();
    await writeFile(paths.config, '[ai]\nprovider = "anthropic"\n', "utf8");
    await expect(loadConfig(paths)).rejects.toBeInstanceOf(ConfigError);
  });

  test("reports malformed TOML instead of throwing something opaque", async () => {
    const paths = await tempPaths();
    await writeFile(paths.config, "this is = = not toml", "utf8");
    await expect(loadConfig(paths)).rejects.toBeInstanceOf(ConfigError);
  });

  test("reports an invalid value with the offending field", async () => {
    const paths = await tempPaths();
    await writeFile(paths.config, '[ai]\nproviders = ["telepathy"]\n', "utf8");
    try {
      await loadConfig(paths);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).detail).toContain("ai.providers");
    }
  });
});

describe("secrets", () => {
  test("returns an empty object when absent", async () => {
    const paths = await tempPaths();
    expect(await loadSecrets(paths)).toEqual({});
  });

  test("is written at mode 600", async () => {
    const paths = await tempPaths();
    await saveSecrets(paths, { adzuna: { appId: "id", appKey: "key" } });
    const info = await stat(paths.secrets);
    expect(info.mode & 0o777).toBe(0o600);
  });

  test("round-trips credentials", async () => {
    const paths = await tempPaths();
    await saveSecrets(paths, { adzuna: { appId: "abc", appKey: "def" } });
    const back = await loadSecrets(paths);
    expect(back.adzuna).toEqual({ appId: "abc", appKey: "def" });
  });
});
