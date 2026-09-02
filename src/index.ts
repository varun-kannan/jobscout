#!/usr/bin/env bun
/**
 * jobscout — search many job engines at once, ranked by real skill overlap.
 *
 * Commands live in src/cli/ and hold no logic: each one parses arguments and
 * calls a service. That is what lets `run` chain stages without shelling out.
 */

import { defineCommand, runMain } from "citty";
import { guardAll } from "./cli/guard.ts";
import { initCommand } from "./cli/init.ts";
import { discoverCommand } from "./cli/discover.ts";
import { skillsCommand } from "./cli/skills.ts";
import { matchCommand } from "./cli/match.ts";
import { draftCommand, enrichCommand, runCommand, scoreCommand } from "./cli/ai-commands.ts";
import { reviewCommand } from "./cli/review.ts";
import { prepareCommand, statusCommand } from "./cli/status.ts";
import { applyCommand } from "./cli/apply.ts";
import { boardsCommand } from "./cli/boards.ts";
import { configCommand } from "./cli/config.ts";

const main = defineCommand({
  meta: {
    name: "jobscout",
    version: "0.1.0",
    description: "Search twenty job engines at once, ranked by how many of your skills each role asks for",
  },
  subCommands: guardAll({
    init: initCommand,
    discover: discoverCommand,
    boards: boardsCommand,
    skills: skillsCommand,
    match: matchCommand,
    enrich: enrichCommand,
    score: scoreCommand,
    draft: draftCommand,
    review: reviewCommand,
    prepare: prepareCommand,
    apply: applyCommand,
    status: statusCommand,
    config: configCommand,
    run: runCommand,
  }),
});

// Known failures are handled per-command by guardAll, which prints them and
// exits. Anything reaching here is a genuine bug and keeps its stack trace.
runMain(main);
