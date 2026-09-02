/**
 * The single list of everything that must be true for jobscout to work.
 *
 * Order matters: checks run top to bottom, and later checks may depend on
 * earlier ones having repaired something (the database check needs the data
 * directory to exist first).
 */

import type { Check } from "./check.ts";
import { environmentChecks } from "./environment.ts";
import { aiBackendCheck } from "./ai-backend.ts";
import { profileChecks } from "./resume.ts";
import { engineChecks } from "./engines.ts";

export const ALL_CHECKS: Check[] = [
  ...environmentChecks,
  aiBackendCheck,
  ...profileChecks,
  ...engineChecks,
];
