/**
 * Choosing an AI backend, interactively.
 *
 * The order is deliberate: agent CLIs first, because they spend a subscription
 * you already hold and cost nothing per call; then Ollama, which is free and
 * local; and only then a paid API, which is never reached unless you ask for
 * it.
 *
 * Nothing is installed without being asked, and nothing that needs your
 * password is run at all — the command is printed and you run it.
 */

import { isCancel, note, password, select, log as clackLog } from "@clack/prompts";
import type { AiProvider, Secrets } from "../config/schema.ts";
import { commandExists } from "../ai/providers/provider.ts";
import { OllamaClient } from "../ai/providers/ollama.ts";
import { c } from "../output/theme.ts";

export interface BackendStatus {
  id: AiProvider;
  label: string;
  available: boolean;
  /** Why it is not available, in a form worth showing. */
  detail: string;
  /** Free with a subscription or entirely local. */
  free: boolean;
}

/** The chain jobscout prefers, best-and-cheapest first. */
export const PREFERRED_CHAIN: readonly AiProvider[] = [
  "claude-code",
  "codex-cli",
  "gemini-cli",
  "ollama",
];

const INSTALL: Partial<Record<AiProvider, { label: string; commands: string[]; note?: string }>> = {
  "claude-code": {
    label: "Claude Code",
    commands:
      process.platform === "win32"
        ? ["irm https://claude.ai/install.ps1 | iex"]
        : ["curl -fsSL https://claude.ai/install.sh | bash", "# or: brew install --cask claude-code"],
    note: "Then run `claude` once to sign in. Needs a Pro, Max, Team, Enterprise or Console plan.",
  },
  "codex-cli": {
    label: "Codex CLI",
    commands: ["npm install -g @openai/codex"],
    note: "Then run `codex` once to sign in with your ChatGPT account.",
  },
  "gemini-cli": {
    label: "Gemini CLI",
    commands: ["npm install -g @google/gemini-cli"],
    note: "Then run `gemini` once to sign in with your Google account.",
  },
  ollama: {
    label: "Ollama",
    commands:
      process.platform === "darwin"
        ? ["brew install ollama", "ollama serve", "ollama pull llama3.1:8b"]
        : ["curl -fsSL https://ollama.com/install.sh | sh", "ollama pull llama3.1:8b"],
    note: "Runs entirely on your machine. No account, no key, nothing leaves the laptop.",
  },
};

/** Probe every backend jobscout can reach. */
export async function probeBackends(secrets: Secrets): Promise<BackendStatus[]> {
  const [claude, codex, gemini, ollamaUp] = await Promise.all([
    commandExists("claude"),
    commandExists("codex"),
    commandExists("gemini"),
    new OllamaClient().available(),
  ]);

  return [
    {
      id: "claude-code",
      label: "Claude Code",
      available: claude,
      detail: claude ? "installed" : "not installed",
      free: true,
    },
    {
      id: "codex-cli",
      label: "Codex CLI",
      available: codex,
      detail: codex ? "installed" : "not installed",
      free: true,
    },
    {
      id: "gemini-cli",
      label: "Gemini CLI",
      available: gemini,
      detail: gemini ? "installed" : "not installed",
      free: true,
    },
    {
      id: "ollama",
      label: "Ollama (local)",
      available: ollamaUp,
      detail: ollamaUp ? "running" : "not running",
      free: true,
    },
    {
      id: "anthropic",
      label: "Anthropic API",
      available: Boolean(secrets.anthropic?.apiKey),
      detail: secrets.anthropic?.apiKey ? "key set" : "no key",
      free: false,
    },
    {
      id: "openai",
      label: "OpenAI API",
      available: Boolean(secrets.openai?.apiKey),
      detail: secrets.openai?.apiKey ? "key set" : "no key",
      free: false,
    },
    {
      id: "gemini",
      label: "Gemini API",
      available: Boolean(secrets.gemini?.apiKey),
      detail: secrets.gemini?.apiKey ? "key set" : "no key",
      free: false,
    },
  ];
}

/** Render the probe as a readable block. */
export function renderBackends(statuses: readonly BackendStatus[]): string {
  return statuses
    .map((s) => {
      const mark = s.available ? c.green("✓") : c.dim("○");
      const name = s.label.padEnd(18);
      const detail = s.available ? c.dim(s.detail) : c.dim(s.detail);
      const cost = s.free ? c.dim("free") : c.yellow("paid");
      return `${mark} ${name}${detail.padEnd(24)}${cost}`;
    })
    .join("\n");
}

export interface SetupOutcome {
  /** The chain to write to config, best first. */
  providers: AiProvider[];
  secrets: Secrets;
  /** True when the user chose to continue without any AI. */
  withoutAi: boolean;
  /** True when they were told how to install something and should re-run. */
  awaitingInstall: boolean;
}

function showInstall(id: AiProvider): void {
  const spec = INSTALL[id];
  if (!spec) return;
  note(
    [
      ...spec.commands.map((cmd) => (cmd.startsWith("#") ? c.dim(cmd) : c.cyan(cmd))),
      "",
      c.dim(spec.note ?? ""),
      c.dim("Then re-run `jobscout init`."),
    ].join("\n"),
    `Install ${spec.label}`,
  );
}

/** Ask for an API key and store it. The value is masked and never echoed. */
async function collectKey(
  provider: "anthropic" | "openai" | "gemini",
  secrets: Secrets,
): Promise<Secrets | null> {
  const where: Record<string, string> = {
    anthropic: "https://console.anthropic.com/settings/keys",
    openai: "https://platform.openai.com/api-keys",
    gemini: "https://aistudio.google.com/apikey",
  };

  note(
    [c.dim("Create a key at:"), c.cyan(where[provider]!), "", c.dim("It is stored in secrets.toml at mode 600 and never printed.")].join("\n"),
    `${provider} API key`,
  );

  const value = await password({
    message: `Paste your ${provider} API key`,
    validate: (v) => (v && v.length > 10 ? undefined : "That does not look like a key."),
  });
  if (isCancel(value)) return null;

  return { ...secrets, [provider]: { apiKey: value } } as Secrets;
}

/**
 * Walk the user to a working backend.
 *
 * Returns the chain to persist. Called only when nothing usable was found, so
 * the common case — an already-installed CLI — never sees a prompt.
 */
export async function chooseBackend(
  statuses: readonly BackendStatus[],
  secrets: Secrets,
  options: { interactive: boolean } = { interactive: true },
): Promise<SetupOutcome> {
  const unchanged: SetupOutcome = {
    providers: [...PREFERRED_CHAIN],
    secrets,
    withoutAi: false,
    awaitingInstall: false,
  };

  // A scripted run (`--yes`, or no terminal) must not block on a menu. It
  // continues without AI, which installs nothing and spends nothing, and says
  // how to set one up later.
  if (!options.interactive) {
    // Rendered only where someone can read it. Writing a boxed note into
    // piped output or a test run is noise, not information.
    if (process.stdout.isTTY) note(
      [
        c.dim("No AI backend found. Continuing without one —"),
        c.dim("discovery, matching and ranking are unaffected; drafting is not available."),
        "",
        c.dim("To set one up, run `jobscout init` in a terminal, or:"),
        c.cyan("  curl -fsSL https://claude.ai/install.sh | bash"),
      ].join("\n"),
      "No AI",
    );
    // The chain is left intact rather than emptied. It is a preference, not a
    // record of what happens to be installed — clearing it here would mean
    // installing Claude Code later had no effect until `init` was run again.
    // Nothing being available is already handled at runtime.
    return { providers: [...PREFERRED_CHAIN], secrets, withoutAi: true, awaitingInstall: false };
  }

  const choice = await select({
    message: "No AI backend is available. What would you like to do?",
    options: [
      {
        value: "claude-code",
        label: "Install Claude Code",
        hint: "best quality · free with a Claude Pro or Max plan",
      },
      {
        value: "ollama",
        label: "Install Ollama",
        hint: "free · local · no account, no key, nothing leaves your machine",
      },
      { value: "codex-cli", label: "Install Codex CLI", hint: "free with a ChatGPT plan" },
      { value: "api", label: "Use an API key", hint: "paid per token · set a spend limit" },
      {
        value: "none",
        label: "Continue without AI",
        hint: "discovery, matching and ranking still work; drafting does not",
      },
    ],
  });

  if (isCancel(choice)) return { ...unchanged, withoutAi: true };

  if (choice === "none") {
    clackLog.info("No AI. Matching and ranking are unaffected — only drafting is lost.");
    return { providers: [], secrets, withoutAi: true, awaitingInstall: false };
  }

  if (choice === "api") {
    const provider = await select({
      message: "Which API?",
      options: [
        { value: "anthropic", label: "Anthropic", hint: "Claude models" },
        { value: "openai", label: "OpenAI", hint: "GPT models" },
        { value: "gemini", label: "Google", hint: "Gemini models" },
      ],
    });
    if (isCancel(provider)) return { ...unchanged, withoutAi: true };

    const updated = await collectKey(provider as "anthropic" | "openai" | "gemini", secrets);
    if (!updated) return { ...unchanged, withoutAi: true };

    clackLog.warn(
      "A paid backend is now enabled. Set a spend limit with `jobscout config --budget 5`.",
    );
    return {
      // The CLIs stay ahead of it, so a later install is preferred automatically.
      providers: [...PREFERRED_CHAIN, provider as AiProvider],
      secrets: updated,
      withoutAi: false,
      awaitingInstall: false,
    };
  }

  showInstall(choice as AiProvider);
  return { ...unchanged, awaitingInstall: true };
}
