/**
 * Ollama — models running on your own machine.
 *
 * The only backend that is both free and private: no key, no spend, and
 * nothing leaves the laptop. That makes it the natural home for the `extract`
 * tier, which runs roughly 120 times per discovery and asks only for
 * structured extraction rather than judgement.
 *
 * Ollama supports a `format` parameter taking a JSON Schema, so the same
 * schema used everywhere else is enforced here too.
 */

import { z, type ZodType } from "zod";
import {
  ProviderError,
  parseJson,
  validate,
  type AiProviderClient,
  type AskInput,
  type AskResult,
} from "./provider.ts";

const DEFAULT_HOST = "http://127.0.0.1:11434";

interface OllamaResponse {
  message?: { content?: string };
  response?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaClient implements AiProviderClient {
  readonly id = "ollama" as const;
  readonly label = "Ollama (local)";
  readonly paid = false;

  constructor(private readonly host: string = process.env.OLLAMA_HOST || DEFAULT_HOST) {}

  async available(): Promise<boolean> {
    try {
      const response = await fetch(`${this.host}/api/tags`, {
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async ask<T>(input: AskInput<T>): Promise<AskResult<T>> {
    const schema = z.toJSONSchema(input.schema as ZodType);

    const response = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: input.signal,
      body: JSON.stringify({
        model: input.model,
        stream: false,
        // Ollama enforces a JSON Schema directly, so the same schema used for
        // every other provider applies here too.
        format: schema,
        options: { temperature: 0 },
        messages: [
          ...(input.system ? [{ role: "system", content: input.system }] : []),
          {
            role: "user",
            content: input.context
              ? `${input.instruction}\n\n---\n${input.context}`
              : input.instruction,
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ProviderError(
        `HTTP ${response.status}: ${body.slice(0, 160)}`,
        this.id,
        response.status >= 500,
      );
    }

    const payload = (await response.json()) as OllamaResponse;
    if (payload.error) throw new ProviderError(payload.error.slice(0, 200), this.id);

    const text = payload.message?.content ?? payload.response ?? "";
    return {
      value: validate(input.schema, parseJson(text), this.id),
      // Recorded even though it is free, so local usage stays visible.
      usage: {
        inputTokens: payload.prompt_eval_count,
        outputTokens: payload.eval_count,
      },
      model: input.model,
    };
  }

  /** Models pulled locally, for setup to offer a real choice. */
  async models(): Promise<string[]> {
    try {
      const response = await fetch(`${this.host}/api/tags`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return [];
      const payload = (await response.json()) as { models?: Array<{ name?: string }> };
      return (payload.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    } catch {
      return [];
    }
  }
}
