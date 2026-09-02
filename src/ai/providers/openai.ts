/**
 * OpenAI.
 *
 * Uses structured outputs — `response_format: { type: "json_schema" }` — so the
 * model is constrained to the schema rather than asked nicely for it.
 *
 * Written against the documented API shape and not exercised against a live
 * key, since none was available here.
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

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string; refusal?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
  model?: string;
}

/**
 * OpenAI's strict mode rejects schemas it considers open-ended, so every
 * object must forbid extra properties and mark all its keys required.
 */
function strictify(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictify);
  if (!schema || typeof schema !== "object") return schema;

  const node = { ...(schema as Record<string, unknown>) };
  for (const key of ["properties", "items", "$defs", "definitions"]) {
    if (node[key]) node[key] = strictify(node[key]);
  }
  if (node.type === "object" && node.properties) {
    node.additionalProperties = false;
    node.required = Object.keys(node.properties as Record<string, unknown>);
  }
  return node;
}

export class OpenAiClient implements AiProviderClient {
  readonly id = "openai" as const;
  readonly label = "OpenAI";
  readonly paid = true;

  constructor(private readonly apiKey: string) {}

  async available(): Promise<boolean> {
    return this.apiKey.length > 0;
  }

  async ask<T>(input: AskInput<T>): Promise<AskResult<T>> {
    const schema = strictify(z.toJSONSchema(input.schema as ZodType));

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      signal: input.signal,
      body: JSON.stringify({
        model: input.model,
        messages: [
          ...(input.system ? [{ role: "system", content: input.system }] : []),
          {
            role: "user",
            content: input.context
              ? `${input.instruction}\n\n---\n${input.context}`
              : input.instruction,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "answer", strict: true, schema },
        },
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

    const payload = (await response.json()) as OpenAiResponse;
    if (payload.error?.message) throw new ProviderError(payload.error.message, this.id);

    const choice = payload.choices?.[0]?.message;
    // A refusal is a deliberate answer, not a malformed one, so it is reported
    // as itself rather than as a parse failure.
    if (choice?.refusal) throw new ProviderError(`refused: ${choice.refusal}`, this.id);

    return {
      value: validate(input.schema, parseJson(choice?.content ?? ""), this.id),
      usage: {
        inputTokens: payload.usage?.prompt_tokens,
        outputTokens: payload.usage?.completion_tokens,
      },
      model: payload.model ?? input.model,
    };
  }
}
