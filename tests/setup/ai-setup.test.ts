import { describe, expect, test } from "bun:test";
import {
  chooseBackend,
  pickBackends,
  probeBackends,
  renderBackends,
  type BackendStatus,
} from "../../src/setup/ai-setup.ts";
import { defaultConfig, type AiProvider } from "../../src/config/schema.ts";

describe("a fresh install", () => {
  /** Nothing is chosen on a new user's behalf. */
  test("has no AI provider selected", () => {
    expect(defaultConfig().ai.providers).toEqual([]);
  });
});

describe("pickBackends", () => {
  /** Only usable backends are offered; with none, there is nothing to ask. */
  test("returns an empty choice without prompting when nothing is usable", async () => {
    const statuses: BackendStatus[] = [
      { id: "claude-code", label: "Claude Code", available: false, detail: "not installed", free: true },
    ];
    expect(await pickBackends(statuses)).toEqual([]);
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

  /** A scripted run must not pick providers on the user's behalf. */
  test("chooses no providers", async () => {
    const outcome = await chooseBackend(await probeBackends({}), {}, { interactive: false });
    expect(outcome.providers).toEqual([]);
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
