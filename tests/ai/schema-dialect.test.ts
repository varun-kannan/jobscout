import { describe, expect, test } from "bun:test";
import { jsonSchemaFor } from "../../src/ai/providers/provider.ts";
import {
  normaliseSchema,
  jobSkillsSchema,
  scoreSchema,
  signalsSchema,
  dedupeSchema,
  draftSchema,
} from "../../src/ai/schemas.ts";

/**
 * Claude Code resolves `$schema` against its own registry and rejects the whole
 * document when the URL is not there:
 *
 *   --json-schema is not a valid JSON Schema:
 *   no schema with key or ref "https://json-schema.org/draft/2020-12/schema"
 *
 * Zod stamps that URL on everything it generates, so every AI stage failed on
 * the default backend while the schemas themselves were valid.
 */
describe("jsonSchemaFor", () => {
  // Every schema that reaches a provider, so none can regress alone.
  const schemas = {
    normaliseSchema, jobSkillsSchema, scoreSchema,
    signalsSchema, dedupeSchema, draftSchema,
  };

  for (const [name, schema] of Object.entries(schemas)) {
    test(`${name} carries no $schema dialect annotation`, () => {
      expect(jsonSchemaFor(schema as never)).not.toHaveProperty("$schema");
    });
  }

  test("keeps everything a provider actually needs", () => {
    const out = jsonSchemaFor(scoreSchema as never) as Record<string, unknown>;
    expect(out.type).toBe("object");
    expect(out).toHaveProperty("properties");
    expect(out.required).toEqual(["score", "reason", "concerns", "roleTypeMatch"]);
    expect(out.additionalProperties).toBe(false);
  });

  test("survives a round trip through JSON, as the CLI flag requires", () => {
    const out = jsonSchemaFor(scoreSchema as never);
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });
});
