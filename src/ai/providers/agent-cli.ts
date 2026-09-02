/**
 * Other agent CLIs — `gemini` and `codex`.
 *
 * Shelled out to the same way as Claude Code, so a subscription you already
 * hold can be reused without a key. They are the weakest backends here, and
 * the reason is worth stating plainly: neither offers an equivalent to Claude
 * Code's `--json-schema`, so the schema can only be *asked for* in the prompt
 * and then validated afterwards. A refused or malformed answer is caught, but
 * it is caught later and costs a whole call.
 *
 * Neither CLI was installed here, so these paths ship unverified. If the flags
 * below are wrong for your version, they will fail cleanly at `available()` or
 * on the first call rather than silently misbehaving.
 */

import { z, type ZodType } from "zod";
import type { AiProvider } from "../../config/schema.ts";
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

interface CliSpec {
  id: AiProvider;
  label: string;
  binary: string;
  /** Build the argument list for a one-shot, non-interactive run. */
  args(model: string): string[];
}

const SPECS: Record<"gemini-cli" | "codex-cli", CliSpec> = {
  "gemini-cli": {
    id: "gemini-cli",
    label: "Gemini CLI",
    binary: "gemini",
    // `-p` is the non-interactive prompt flag, matching the documented usage.
    args: (model) => ["-m", model, "-p"],
  },
  "codex-cli": {
    id: "codex-cli",
    label: "Codex CLI",
    binary: "codex",
    // `exec` is Codex's non-interactive subcommand.
    args: (model) => ["exec", "--model", model],
  },
};

export class AgentCliClient implements AiProviderClient {
  readonly id: AiProvider;
  readonly label: string;
  readonly paid = false;

  private readonly spec: CliSpec;

  constructor(
    kind: "gemini-cli" | "codex-cli",
    private readonly cwd: string,
  ) {
    this.spec = SPECS[kind];
    this.id = this.spec.id;
    this.label = this.spec.label;
  }

  async available(): Promise<boolean> {
    return commandExists(this.spec.binary);
  }

  async ask<T>(input: AskInput<T>): Promise<AskResult<T>> {
    const schema = z.toJSONSchema(input.schema as ZodType);

    // With no schema flag available, the shape has to be requested in the
    // prompt and enforced on the way back.
    const prompt = [
      input.system ? `${input.system}\n\n` : "",
      input.instruction,
      input.context ? `\n\n---\n${input.context}` : "",
      `\n\nReply with JSON matching this schema, and nothing else. No prose, no code fence:\n`,
      JSON.stringify(schema),
    ].join("");

    let stdout: string;
    try {
      stdout = await runCli([this.spec.binary, ...this.spec.args(input.model), prompt], {
        cwd: this.cwd,
      });
    } catch (err) {
      throw new ProviderError(String(err instanceof Error ? err.message : err), this.id);
    }

    const parsed = parseJson(stdout);
    if (parsed === undefined) {
      throw new ProviderError(
        `no JSON in the reply: ${stdout.slice(0, 160)}`,
        this.id,
        true,
      );
    }

    return {
      value: validate(input.schema, parsed, this.id),
      // These CLIs report no usage, so cost cannot be derived. They are
      // subscription-backed and treated as free, which is what `paid` says.
      usage: {},
      model: input.model,
    };
  }
}
