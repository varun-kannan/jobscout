/**
 * Turning known failures into messages.
 *
 * Left to citty, a thrown error prints as `ERROR <message>` followed by a stack
 * trace into the compiled binary — `/$bunfs/root/jobscout:123683` — which tells
 * the user nothing and buries the explanation the error already carried.
 *
 * Every command is wrapped, so a failure it can describe is described, and only
 * a genuine bug reaches the default handler with its trace intact.
 */

import type { CommandDef } from "citty";
import { ConfigError } from "../config/load.ts";
import { BudgetExceededError, NoAiError } from "../ai/client.ts";
import { hint, line, warn } from "../output/theme.ts";

/**
 * Commands in one map have different argument shapes, so the element type has
 * to be permissive. The looseness is confined to this file.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCommand = CommandDef<any>;

/**
 * Describe a known failure as the lines to print, or null when the error is
 * not one we can explain.
 *
 * Kept separate from printing so the decision — which errors are the user's to
 * act on, and what each one should say — can be tested without a terminal.
 */
export function describeError(err: unknown): string[] | null {
  if (err instanceof ConfigError) {
    return [
      warn(err.message),
      hint(`  ${err.path}`),
      ...(err.detail ? err.detail.split("\n").map((l) => hint(`  ${l}`)) : []),
      "",
      hint("  Fix the file by hand, or move it aside and re-run `jobscout init`."),
    ];
  }

  if (err instanceof BudgetExceededError) {
    return [
      warn("Stopped — the spend limit would be exceeded."),
      hint(`  ${err.message}`),
      hint("  Nothing was left half-finished."),
    ];
  }

  if (err instanceof NoAiError) {
    return [warn(err.message), hint("  Discovery, matching and ranking all work without one.")];
  }

  // A database written by a newer build carries its own written explanation.
  if (err instanceof Error && /only understands|schema is version/.test(err.message)) {
    return [warn(err.message)];
  }

  return null;
}

/** Print a known failure. Returns false when the error is not one. */
function explain(err: unknown): boolean {
  const lines = describeError(err);
  if (!lines) return false;
  line();
  for (const l of lines) line(l);
  line();
  return true;
}

/**
 * Wrap one command so its known failures print rather than crash.
 *
 * Generic over the command's own argument shape, so wrapping does not erase
 * the types citty infers for each command's `args`.
 */
export function guard<T extends AnyCommand>(command: T): T {
  const original = command.run;
  if (typeof original !== "function") return command;

  return {
    ...command,
    async run(context: Parameters<typeof original>[0]) {
      try {
        return await original(context);
      } catch (err) {
        if (explain(err)) process.exit(1);
        // Not something we can explain — let it surface with its trace.
        throw err;
      }
    },
  } as T;
}

/** Wrap every command in a subcommand map, preserving each one's type. */
export function guardAll<T extends Record<string, AnyCommand>>(commands: T): T {
  return Object.fromEntries(
    Object.entries(commands).map(([name, command]) => [name, guard(command)]),
  ) as T;
}
