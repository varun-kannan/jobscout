import { defineCommand } from "citty";
import { runInit } from "../setup/init.ts";

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Set up, verify, and repair everything — the only setup step",
  },
  args: {
    yes: {
      type: "boolean",
      alias: "y",
      description: "Accept every default; no prompts",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description: "Report what would change; change nothing",
      default: false,
    },
    repair: {
      type: "boolean",
      description: "Skip questions; only detect and fix what is broken",
      default: false,
    },
    all: {
      type: "boolean",
      description: "Enable all twenty engines, walking through each credential",
      default: false,
    },
    // See apply.ts: `--no-ai` is a negation of `ai`, not a flag of its own.
    ai: {
      type: "boolean",
      description: "Use Claude Code (--no-ai sets up without it)",
      default: true,
    },
    root: {
      type: "string",
      description: "Data directory (default: ~/jobscout, or $JOBSCOUT_HOME)",
    },
  },
  async run({ args }) {
    const outcome = await runInit({
      root: args.root as string | undefined,
      assumeYes: Boolean(args.yes) || Boolean(args.repair),
      dryRun: Boolean(args["dry-run"]),
      repair: Boolean(args.repair),
      all: Boolean(args.all),
      noAi: args.ai === false,
    });
    if (!outcome.ok) process.exitCode = 1;
  },
});
