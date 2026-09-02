/**
 * `jobscout doctor` — report what is missing, change nothing.
 *
 * This is `init --dry-run` under the name people actually look for. It holds
 * no checks of its own: it runs the same registry `init` runs, so the two can
 * never disagree about whether an install is healthy.
 *
 * Exits non-zero when something is wrong, which makes it usable in a script.
 */

import { defineCommand } from "citty";
import { runInit } from "../setup/init.ts";

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Check every requirement and report the gaps — fixes nothing",
  },
  args: {
    root: {
      type: "string",
      description: "Data directory (default: ~/jobscout, or $JOBSCOUT_HOME)",
    },
  },
  async run({ args }) {
    const outcome = await runInit({
      root: args.root as string | undefined,
      // A report must never prompt, never install, and never write.
      assumeYes: true,
      dryRun: true,
      repair: false,
      all: false,
      noAi: false,
      label: "doctor",
    });
    if (!outcome.ok) process.exitCode = 1;
  },
});
