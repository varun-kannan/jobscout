/**
 * Anthropic — the Claude Code CLI, and the raw API.
 *
 * Two providers in one file because they talk to the same models by different
 * routes: the CLI spends a subscription you already pay for, the API spends
 * per token.
 */

import { z, type ZodType } from "zod";
import {
  commandExists,
  parseJson,
  ProviderError,
  runCli,
  validate,
  type AiProviderClient,
  type AskInput,
  type AskResult,
} from "./provider.ts";

/* ── Claude Code ──────────────────────────────────────────────────── */

interface ClaudeJson {
  result?: string;
  structured_output?: unknown;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class ClaudeCodeClient implements AiProviderClient {
  readonly id = "claude-code" as const;
  readonly label = "Claude Code";
  readonly paid = false;

  /**
   * @param cwd Directory the subprocess runs in — the jobscout data folder,
   * which has no `.claude/`. Without `--bare`, Claude Code loads hooks and MCP
   * servers from its working directory, and running in whatever project the
   * user happens to be in would execute that project's configuration.
   */
  constructor(private readonly cwd: string) {}

  async available(): Promise<boolean> {
    return commandExists("claude");
  }

  async ask<T>(input: AskInput<T>): Promise<AskResult<T>> {
    const schema = z.toJSONSchema(input.schema as ZodType);

    const args = [
      "-p",
      input.instruction,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(schema),
      // Nothing here needs to read files or run commands, so denying by
      // default means a prompt cannot talk the agent into touching the machine.
      "--permission-mode",
      "dontAsk",
    ];
    if (input.system) args.push("--append-system-prompt", input.system);

    // Deliberately not `--bare`: it skips subscription login and demands an
    // API key, which would break the "no key, no cost" promise.
    let stdout: string;
    try {
      stdout = await runCli(["claude", ...args], { cwd: this.cwd, stdin: input.context });
    } catch (err) {
      throw new ProviderError(String(err instanceof Error ? err.message : err), this.id);
    }

    let payload: ClaudeJson;
    try {
      payload = JSON.parse(stdout) as ClaudeJson;
    } catch {
      throw new ProviderError(`unparseable output: ${stdout.slice(0, 160)}`, this.id);
    }
    if (payload.is_error) {
      throw new ProviderError(String(payload.result).slice(0, 200), this.id);
    }

    const raw = payload.structured_output ?? parseJson(payload.result ?? "") ?? payload.result;

    return {
      value: validate(input.schema, raw, this.id),
      usage: {
        inputTokens: payload.usage?.input_tokens,
        outputTokens: payload.usage?.output_tokens,
        // Claude Code reports its own figure. Its documentation calls this a
        // client-side estimate that can differ from the actual bill, so it is
        // recorded as reported rather than treated as authoritative.
        reportedUsd: payload.total_cost_usd,
      },
      model: input.model,
    };
  }
}

/* ── Anthropic API ────────────────────────────────────────────────── */

interface AnthropicResponse {
  content?: Array<{ text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
  error?: { message?: string };
}

export class AnthropicClient implements AiProviderClient {
  readonly id = "anthropic" as const;
  readonly label = "Anthropic API";
  readonly paid = true;

  constructor(private readonly apiKey: string) {}

  async available(): Promise<boolean> {
    return this.apiKey.length > 0;
  }

  async ask<T>(input: AskInput<T>): Promise<AskResult<T>> {
    const schema = z.toJSONSchema(input.schema as ZodType);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: input.signal,
      body: JSON.stringify({
        model: input.model,
        max_tokens: 4096,
        temperature: 0,
        system: input.system,
        messages: [
          {
            role: "user",
            content: [
              input.instruction,
              input.context ? `\n\n---\n${input.context}` : "",
              `\n\nReply with JSON matching this schema, and nothing else:\n${JSON.stringify(schema)}`,
            ].join(""),
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ProviderError(
        `HTTP ${response.status}: ${body.slice(0, 200)}`,
        this.id,
        response.status === 429 || response.status >= 500,
      );
    }

    const payload = (await response.json()) as AnthropicResponse;
    if (payload.error?.message) throw new ProviderError(payload.error.message, this.id);

    const text = payload.content?.map((c) => c.text ?? "").join("") ?? "";
    return {
      value: validate(input.schema, parseJson(text), this.id),
      usage: {
        inputTokens: payload.usage?.input_tokens,
        outputTokens: payload.usage?.output_tokens,
      },
      model: payload.model ?? input.model,
    };
  }
}
