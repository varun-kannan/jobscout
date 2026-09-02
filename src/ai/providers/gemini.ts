/**
 * Google Gemini.
 *
 * Constrains output with `responseSchema` plus a JSON mime type.
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

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

/**
 * Gemini accepts a subset of JSON Schema and rejects unknown keywords, so
 * annotations that carry no constraint are stripped.
 */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;

  const node: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "$schema" || key === "additionalProperties" || key === "exclusiveMinimum") continue;
    node[key] = toGeminiSchema(value);
  }
  return node;
}

export class GeminiClient implements AiProviderClient {
  readonly id = "gemini" as const;
  readonly label = "Gemini";
  readonly paid = true;

  constructor(private readonly apiKey: string) {}

  async available(): Promise<boolean> {
    return this.apiKey.length > 0;
  }

  async ask<T>(input: AskInput<T>): Promise<AskResult<T>> {
    const schema = toGeminiSchema(z.toJSONSchema(input.schema as ZodType));
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(input.model)}:generateContent`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      signal: input.signal,
      body: JSON.stringify({
        systemInstruction: input.system ? { parts: [{ text: input.system }] } : undefined,
        contents: [
          {
            role: "user",
            parts: [
              {
                text: input.context
                  ? `${input.instruction}\n\n---\n${input.context}`
                  : input.instruction,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: schema,
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

    const payload = (await response.json()) as GeminiResponse;
    if (payload.error?.message) throw new ProviderError(payload.error.message, this.id);

    const candidate = payload.candidates?.[0];
    // A truncated answer would fail schema validation with a confusing message,
    // so the real cause is reported instead.
    if (candidate?.finishReason === "MAX_TOKENS") {
      throw new ProviderError("answer was cut off before it finished", this.id, true);
    }

    const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return {
      value: validate(input.schema, parseJson(text), this.id),
      usage: {
        inputTokens: payload.usageMetadata?.promptTokenCount,
        outputTokens: payload.usageMetadata?.candidatesTokenCount,
      },
      model: input.model,
    };
  }
}
