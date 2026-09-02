import { describe, expect, test } from "bun:test";
import {
  PREFERRED_CHAIN,
  chooseBackend,
  probeBackends,
  renderBackends,
  type BackendStatus,
} from "../../src/setup/ai-setup.ts";
import { PAID_PROVIDERS, defaultConfig, type AiProvider } from "../../src/config/schema.ts";

describe("the preferred chain", () => {
  /** Free-with-subscription first: the default must never cost anything. */
  test("contains no paid provider", () => {
    for (const paid of PAID_PROVIDERS) expect(PREFERRED_CHAIN).not.toContain(paid);
  });

  test("puts Claude Code first and Ollama last", () => {
    expect(PREFERRED_CHAIN[0]).toBe("claude-code");
    expect(PREFERRED_CHAIN[PREFERRED_CHAIN.length - 1]).toBe("ollama");
  });

  test("is what a fresh install ships with", () => {
    expect(defaultConfig().ai.providers).toEqual([...PREFERRED_CHAIN]);
  });
});

describe("probeBackends", () => {
  test("reports every backend, whether or not it is present", async () => {
    const statuses = await probeBackends({});
    const ids = statuses.map((s) => s.id);
    const expected: AiProvider[] = [
      "claude-code", "codex-cli", "gemini-cli", "ollama", "anthropic", "openai", "gemini",
    ];
    for (const id of expected) {
      expect(ids).toContain(id);
    }
  });

  test("marks the CLIs and Ollama free, and the APIs paid", async () => {
    const byId = new Map((await probeBackends({})).map((s) => [s.id, s]));
    expect(byId.get("claude-code")!.free).toBe(true);
    expect(byId.get("ollama")!.free).toBe(true);
    expect(byId.get("openai")!.free).toBe(false);
  });

  test("an API counts as available exactly when its key is stored", async () => {
    const without = await probeBackends({});
    expect(without.find((s) => s.id === "openai")!.available).toBe(false);

    const with_ = await probeBackends({ openai: { apiKey: "sk-test-key" } });
    expect(with_.find((s) => s.id === "openai")!.available).toBe(true);
    expect(with_.find((s) => s.id === "openai")!.detail).toBe("key set");
  });

  test("does not throw when nothing at all is installed", async () => {
    await expect(probeBackends({})).resolves.toBeArray();
  });
});

describe("renderBackends", () => {
  const statuses: BackendStatus[] = [
    { id: "claude-code", label: "Claude Code", available: true, detail: "installed", free: true },
    { id: "openai", label: "OpenAI API", available: false, detail: "no key", free: false },
  ];

  test("marks what is present and labels what costs money", () => {
    const rendered = renderBackends(statuses);
    expect(rendered).toContain("Claude Code");
    expect(rendered).toContain("installed");
    expect(rendered).toContain("no key");
    expect(rendered).toContain("paid");
    expect(rendered.split("\n")).toHaveLength(2);
  });
});

describe("chooseBackend, non-interactively", () => {
  /**
   * `--yes` and a piped stdin both mean nobody is there to answer. Prompting
   * anyway made `jobscout init --yes` hang forever on a menu.
   */
  test("continues without AI rather than blocking on a menu", async () => {
    const outcome = await chooseBackend(await probeBackends({}), {}, { interactive: false });
    expect(outcome.withoutAi).toBe(true);
    expect(outcome.awaitingInstall).toBe(false);
  });

  /**
   * The chain is a preference, not a record of what happens to be installed.
   * Emptying it here meant a scripted `init --yes` on a machine with no backend
   * wrote `providers = []`, so installing Claude Code afterwards had no effect
   * until `init` was run a second time.
   */
  test("leaves the preferred chain intact for a later install", async () => {
    const outcome = await chooseBackend(await probeBackends({}), {}, { interactive: false });
    expect(outcome.providers).toEqual([...PREFERRED_CHAIN]);
  });

  test("installs nothing and stores nothing", async () => {
    const secrets = { openai: { apiKey: "sk-existing" } };
    const outcome = await chooseBackend(await probeBackends(secrets), secrets, {
      interactive: false,
    });
    // Whatever was already there is handed back untouched.
    expect(outcome.secrets).toBe(secrets);
  });
});
