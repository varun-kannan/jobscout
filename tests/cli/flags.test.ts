/**
 * Guarding the `--no-x` flag trap.
 *
 * citty parses `--no-open` as a *negation* of an `open` flag, so an argument
 * literally named "no-open" is set to `false` by passing it and can never read
 * as true. Three flags shipped broken this way, and `apply --no-open` opened
 * browser tabs anyway — a silent side effect, which is the worst kind.
 *
 * The fix is to declare the positive flag and let citty negate it. These tests
 * assert the arguments stay declared that way.
 */

import { describe, expect, test } from "bun:test";
import { applyCommand } from "../../src/cli/apply.ts";
import { initCommand } from "../../src/cli/init.ts";
import { runCommand } from "../../src/cli/ai-commands.ts";

type ArgSpec = Record<string, { type?: string; default?: unknown }>;

async function argsOf(command: unknown): Promise<ArgSpec> {
  const resolved = await (typeof command === "function" ? command() : command);
  return ((resolved as { args?: ArgSpec }).args ?? {}) as ArgSpec;
}

const COMMANDS: Array<[string, unknown, string]> = [
  ["apply", applyCommand, "open"],
  ["init", initCommand, "ai"],
  ["run", runCommand, "draft"],
];

describe.each(COMMANDS)("%s", (name, command, positive) => {
  test(`declares "${positive}" positively, not as "no-${positive}"`, async () => {
    const args = await argsOf(command);
    expect(Object.keys(args)).toContain(positive);
    // The broken form: citty would set this to false when passed, never true.
    expect(Object.keys(args)).not.toContain(`no-${positive}`);
  });

  test(`"${positive}" defaults to true so --no-${positive} can turn it off`, async () => {
    const args = await argsOf(command);
    expect(args[positive]?.type).toBe("boolean");
    // A positive flag defaulting to false would make `--no-x` a no-op again.
    expect(args[positive]?.default).toBe(true);
  });
});

describe("no command declares a no- prefixed boolean", () => {
  test("across every command with arguments", async () => {
    for (const [name, command] of COMMANDS) {
      const args = await argsOf(command);
      const offenders = Object.keys(args).filter((k) => k.startsWith("no-"));
      expect(offenders, `${name} declares ${offenders.join(", ")}`).toEqual([]);
    }
  });
});
