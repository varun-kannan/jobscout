/**
 * The contract every AI backend implements.
 *
 * Providers return what a call used as well as what it produced, because the
 * router records spend and cannot do that from the answer alone. Where a
 * provider reports its own cost — Claude Code does — that figure is preferred
 * over one derived from a price table.
 */

import type { ZodType } from "zod";
import type { AiProvider } from "../../config/schema.ts";

export interface AskInput<T> {
  instruction: string;
  context?: string;
  system?: string;
  schema: ZodType<T>;
  model: string;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** Set only when the provider reported a cost itself. */
  reportedUsd?: number;
}

export interface AskResult<T> {
  value: T;
  usage: Usage;
  /** What actually answered, which may differ from what was asked for. */
  model: string;
}

export interface AiProviderClient {
  readonly id: AiProvider;
  /** Human-facing name for setup and status output. */
  readonly label: string;
  /** True when calls to this provider cost money. */
  readonly paid: boolean;
  /** Is it usable right now — installed, authenticated, key present? */
  available(): Promise<boolean>;
  ask<T>(input: AskInput<T>): Promise<AskResult<T>>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: AiProvider,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Pull JSON out of a model's reply.
 *
 * Models wrap JSON in prose or a fenced block often enough that expecting a
 * clean payload would be fragile, so both are handled.
 */
export function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate =
      fenced?.[1] ?? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
}

/** Validate an answer, failing loudly at the boundary rather than downstream. */
export function validate<T>(schema: ZodType<T>, raw: unknown, provider: AiProvider): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const issues = (parsed.error as { issues?: Array<{ path: PropertyKey[]; message: string }> })
    .issues;
  const detail =
    issues
      ?.slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ") ?? String(parsed.error);

  // Retryable: a shape mismatch is usually a one-off, not a broken provider.
  throw new ProviderError(`returned a shape that does not match the schema — ${detail}`, provider, true);
}

/** Spawn a CLI, feed it stdin, and collect stdout. Shared by the agent CLIs. */
export async function runCli(
  command: string[],
  options: { cwd?: string; stdin?: string; timeoutMs?: number },
): Promise<string> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (options.stdin) proc.stdin.write(options.stdin);
  await proc.stdin.end();

  const timeout = setTimeout(() => proc.kill(), options.timeoutMs ?? 120_000);
  try {
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`exited ${code}: ${(stderr || stdout).slice(0, 200)}`);
    }
    return stdout;
  } finally {
    clearTimeout(timeout);
  }
}

/** Is a command on PATH? */
export async function commandExists(binary: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([binary, "--version"], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
