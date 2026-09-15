/**
 * Editing settings from the UI.
 *
 * The schema stays the single authority: a patch is merged into the current
 * config and the whole thing re-validated, so the UI cannot write anything the
 * CLI would reject. A bad field is refused with the reason rather than being
 * coerced into something that looks fine and behaves oddly later.
 */

import {
  configSchema,
  ENGINE_IDS,
  AI_PROVIDERS,
  type Config,
} from "../config/schema.ts";

export interface PatchResult {
  ok: boolean;
  config?: Config;
  /** Field-by-field reasons, so a form can show them where they belong. */
  errors?: Record<string, string>;
}

/** Values a caller may change. Anything else is ignored rather than refused. */
export interface SettingsPatch {
  roles?: unknown;
  locations?: unknown;
  remoteOnly?: unknown;
  salaryMin?: unknown;
  salaryCurrency?: unknown;
  salaryPeriod?: unknown;
  threshold?: unknown;
  providers?: unknown;
  model?: unknown;
  budgetLimitUsd?: unknown;
  budgetPeriod?: unknown;
  engines?: unknown;
}

/** A list of non-empty strings, however the client chose to send it. */
function stringList(value: unknown): string[] | null {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null;
  if (raw === null) return null;
  return [
    ...new Set(
      raw
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter((v) => v.length > 0),
    ),
  ];
}

/** A number, or null for a deliberately empty field. */
function optionalNumber(value: unknown): number | null | undefined {
  if (value === null || value === "" || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[,_\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Merge a patch into the config and validate the result.
 *
 * Nothing is written here: the caller persists only when this succeeds, so a
 * rejected edit leaves config.toml untouched.
 */
export function applySettings(current: Config, patch: SettingsPatch): PatchResult {
  const errors: Record<string, string> = {};
  const next: Config = {
    ...current,
    search: { ...current.search },
    match: { ...current.match },
    ai: { ...current.ai, budget: { ...current.ai.budget } },
    engines: { ...current.engines },
  };

  if (patch.roles !== undefined) {
    const roles = stringList(patch.roles);
    if (roles === null) errors.roles = "Expected a list of role names";
    else next.search.roles = roles;
  }

  if (patch.locations !== undefined) {
    const locations = stringList(patch.locations);
    if (locations === null) errors.locations = "Expected a list of locations";
    else next.search.locations = locations;
  }

  if (patch.remoteOnly !== undefined) next.search.remoteOnly = Boolean(patch.remoteOnly);

  if (patch.salaryMin !== undefined) {
    const value = optionalNumber(patch.salaryMin);
    if (value === undefined) errors.salaryMin = "Expected a number, or blank for no floor";
    else if (value !== null && value < 0) errors.salaryMin = "Cannot be negative";
    else next.search.salaryMin = value;
  }

  if (patch.salaryCurrency !== undefined) {
    const code = String(patch.salaryCurrency).trim().toUpperCase();
    // Blank is allowed: it is how a fresh install starts, with no floor to compare.
    if (code !== "" && !/^[A-Z]{3}$/.test(code)) {
      errors.salaryCurrency = "Use a three-letter code, or leave it blank";
    } else next.search.salaryCurrency = code;
  }

  if (patch.salaryPeriod !== undefined) {
    const period = String(patch.salaryPeriod);
    if (!["annual", "monthly", "hourly"].includes(period)) {
      errors.salaryPeriod = "One of annual, monthly, hourly";
    } else next.search.salaryPeriod = period as Config["search"]["salaryPeriod"];
  }

  if (patch.threshold !== undefined) {
    const value = Number(patch.threshold);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      errors.threshold = "A number between 0 and 1";
    } else next.match.threshold = value;
  }

  if (patch.providers !== undefined) {
    const list = stringList(patch.providers);
    if (list === null) errors.providers = "Expected a list of providers";
    else {
      const unknown = list.filter((p) => !(AI_PROVIDERS as readonly string[]).includes(p));
      if (unknown.length) errors.providers = `Not a provider: ${unknown.join(", ")}`;
      // An empty chain is a real choice (it means run without AI), so it is
      // allowed, unlike a chain naming something that does not exist.
      else next.ai.providers = list as Config["ai"]["providers"];
    }
  }

  if (patch.model !== undefined) {
    // Blank clears it, which means each provider's own default model.
    next.ai.model = String(patch.model).trim();
  }

  if (patch.budgetLimitUsd !== undefined) {
    const value = optionalNumber(patch.budgetLimitUsd);
    if (value === undefined) errors.budgetLimitUsd = "Expected a number, or blank for no limit";
    else if (value !== null && value < 0) errors.budgetLimitUsd = "Cannot be negative";
    // 0 is how "no limit" is stored, so a blank field and an explicit zero mean
    // the same thing.
    else next.ai.budget.limit = value ?? 0;
  }

  if (patch.budgetPeriod !== undefined) {
    const period = String(patch.budgetPeriod);
    if (!["weekly", "monthly", "none"].includes(period)) {
      errors.budgetPeriod = "One of weekly, monthly, none";
    } else next.ai.budget.period = period as Config["ai"]["budget"]["period"];
  }

  if (patch.engines !== undefined) {
    const list = stringList(patch.engines);
    if (list === null) errors.engines = "Expected a list of engines";
    else {
      const unknown = list.filter((e) => !(ENGINE_IDS as readonly string[]).includes(e));
      // An empty list is allowed: it is where a fresh install starts.
      if (unknown.length) errors.engines = `Not an engine: ${unknown.join(", ")}`;
      else next.engines.enabled = list as Config["engines"]["enabled"];
    }
  }

  if (Object.keys(errors).length) return { ok: false, errors };

  // The schema has the final word, so the UI can never write something the CLI
  // would then refuse to read.
  const parsed = configSchema.safeParse(next);
  if (!parsed.success) {
    const issues: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      issues[issue.path.join(".") || "config"] = issue.message;
    }
    return { ok: false, errors: issues };
  }

  return { ok: true, config: parsed.data };
}

/** What a settings form needs to render its choices. */
export function settingsOptions(): {
  providers: readonly string[];
  engines: readonly string[];
  periods: readonly string[];
  budgetPeriods: readonly string[];
} {
  return {
    providers: AI_PROVIDERS,
    engines: ENGINE_IDS,
    periods: ["annual", "monthly", "hourly"],
    budgetPeriods: ["weekly", "monthly", "none"],
  };
}
