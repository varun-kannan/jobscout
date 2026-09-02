import { describe, expect, test } from "bun:test";
import type { CommandContext } from "citty";
import { describeError, guard } from "../../src/cli/guard.ts";
import { ConfigError } from "../../src/config/load.ts";
import { BudgetExceededError, NoAiError } from "../../src/ai/client.ts";

/** Strip colour so assertions read as plain text. */
function plain(lines: string[] | null): string {
  return (lines ?? []).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("describeError", () => {
  /**
   * A corrupt config used to print citty's `ERROR` plus a stack trace into the
   * compiled binary — `/$bunfs/root/jobscout:123683` — which buried the file,
   * the line, and the caret the TOML parser had already produced.
   */
  test("a bad config names the file, the reason, and what to do", () => {
    const text = plain(
      describeError(
        new ConfigError("config.toml is not valid TOML", "/tmp/x/config.toml", "1:  not = = toml"),
      ),
    );
    expect(text).toContain("config.toml is not valid TOML");
    expect(text).toContain("/tmp/x/config.toml");
    expect(text).toContain("not = = toml");
    expect(text).toContain("jobscout init");
  });

  test("a budget stop says nothing was left half-finished", () => {
    const text = plain(
      describeError(
        new BudgetExceededError(
          "This stage is estimated at $0.21, but only $0.20 is left.",
          { allowed: false } as never,
        ),
      ),
    );
    expect(text).toContain("$0.21");
    expect(text).toContain("half-finished");
  });

  test("having no AI backend points at what still works", () => {
    const text = plain(describeError(new NoAiError("No AI backend is available.")));
    expect(text).toContain("matching and ranking");
  });

  /** The database carries its own explanation; it must not be swallowed. */
  test("a newer schema is reported verbatim", () => {
    const text = plain(
      describeError(new Error("Database schema is version 99, but this build only understands 4.")),
    );
    expect(text).toContain("version 99");
  });

  /**
   * The guard must not turn genuine bugs into tidy messages — a TypeError with
   * no stack trace is far harder to diagnose than one with it.
   */
  test("an ordinary error is not explained away", () => {
    expect(describeError(new TypeError("x is not a function"))).toBeNull();
    expect(describeError("a string")).toBeNull();
  });
});

describe("guard", () => {
  test("passes the context in and the result back out untouched", async () => {
    const context = { args: { yes: true } } as unknown as CommandContext;
    let seen: unknown = null;
    const wrapped = guard({
      run: async (ctx: CommandContext) => {
        seen = ctx;
        return "done";
      },
    });
    expect(await wrapped.run!(context)).toBe("done");
    // Wrapping must not swallow or reshape what citty hands the command.
    expect(seen).toBe(context);
  });

  test("rethrows what it cannot explain, stack intact", async () => {
    const boom = new TypeError("x is not a function");
    const wrapped = guard({
      run: async (_ctx: CommandContext) => {
        throw boom;
      },
    });
    await expect(wrapped.run!({ args: {} } as unknown as CommandContext)).rejects.toBe(boom);
  });

  test("leaves a command with no run function alone", () => {
    const command = { meta: { name: "x" } };
    expect(guard(command)).toBe(command);
  });
});
