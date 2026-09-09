/**
 * What you are actually looking for.
 *
 * `discover` passes these straight to every engine, so an empty set is not a
 * neutral default — it means no engine has an opinion and everything is kept.
 * A first run without them returns a few thousand postings spanning every
 * country and every function, which is indistinguishable from the tool being
 * broken.
 *
 * Nothing here blocks a run: unfiltered search still works, so these are
 * warnings rather than failures.
 */

import { confirm, isCancel, text } from "@clack/prompts";
import { caution, pass, type Check, type CheckContext, type CheckResult } from "./check.ts";
import type { Config } from "../../config/schema.ts";

/** Split a comma-separated answer into clean values. */
export function parseList(input: string): string[] {
  return [
    ...new Set(
      input
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
  ];
}

/**
 * Read a salary as a plain number.
 *
 * People type what they say out loud — "12,00,000", "$120k", "80 000" — so the
 * separators and the unit are stripped rather than rejected. Returns null for
 * an empty answer, which is a valid choice, and for anything with no digits.
 */
export function parseSalary(input: string): number | null {
  const cleaned = input.trim().toLowerCase().replace(/[,_\s$£€₹]/g, "");
  if (cleaned === "") return null;
  const match = cleaned.match(/^(\d+(?:\.\d+)?)(k|l|lpa|m)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const scale = match[2];
  if (scale === "k") return Math.round(amount * 1_000);
  if (scale === "m") return Math.round(amount * 1_000_000);
  // Indian postings are quoted in lakhs, and "12 LPA" is how they are said.
  if (scale === "l" || scale === "lpa") return Math.round(amount * 100_000);
  return Math.round(amount);
}

/** A one-line description of what is currently set. */
export function describePreferences(config: Config): string {
  const { roles, locations, remoteOnly, salaryMin, salaryCurrency } = config.search;
  const parts: string[] = [];
  parts.push(roles.length ? `${roles.length} role(s)` : "no roles");
  parts.push(locations.length ? `${locations.length} location(s)` : "no locations");
  if (remoteOnly) parts.push("remote only");
  if (salaryMin) parts.push(`from ${salaryCurrency} ${salaryMin.toLocaleString()}`);
  return parts.join(" · ");
}

async function ask(ctx: CheckContext): Promise<void> {
  const current = ctx.config.search;

  const roles = await text({
    message: "Which roles are you looking for?",
    placeholder: "backend engineer, payments engineer, platform engineer",
    initialValue: current.roles.join(", "),
    defaultValue: "",
  });
  if (isCancel(roles)) return;

  const locations = await text({
    message: "Where? (comma separated; leave blank for anywhere)",
    placeholder: "Bengaluru, Remote, London",
    initialValue: current.locations.join(", "),
    defaultValue: "",
  });
  if (isCancel(locations)) return;

  const remoteOnly = await confirm({
    message: "Remote roles only?",
    initialValue: current.remoteOnly,
  });
  if (isCancel(remoteOnly)) return;

  const currency = await text({
    message: "Salary currency",
    placeholder: "USD, INR, EUR",
    initialValue: current.salaryCurrency,
    defaultValue: current.salaryCurrency,
  });
  if (isCancel(currency)) return;

  const minimum = await text({
    message: "Minimum salary you would accept (blank to skip)",
    placeholder: "120k · 24 LPA · 90000",
    initialValue: current.salaryMin ? String(current.salaryMin) : "",
    defaultValue: "",
  });
  if (isCancel(minimum)) return;

  ctx.setConfig({
    ...ctx.config,
    search: {
      ...current,
      roles: parseList(roles),
      locations: parseList(locations),
      remoteOnly,
      salaryCurrency: currency.trim().toUpperCase() || current.salaryCurrency,
      salaryMin: parseSalary(minimum),
    },
  });
}

export const preferencesCheck: Check = {
  id: "preferences",
  title: "Search preferences",
  phase: "profile",

  async run(ctx: CheckContext): Promise<CheckResult> {
    const { roles, locations } = ctx.config.search;

    if (roles.length === 0 && locations.length === 0) {
      return caution("not set — every posting is kept", {
        detail: [
          "Engines filter on these. With none set, discovery returns everything",
          "it can reach: every country, every function, thousands of postings.",
        ],
        fix: {
          label: "Set what you are looking for?",
          defaultYes: true,
          async run(inner) {
            await ask(inner);
          },
        },
      });
    }

    // Roles are what actually narrows a search; a location alone still returns
    // every function in that city.
    if (roles.length === 0) {
      return caution(`${describePreferences(ctx.config)} — no roles set`, {
        detail: ["Without roles, every function in those locations is kept."],
        fix: {
          label: "Add the roles you want?",
          defaultYes: true,
          async run(inner) {
            await ask(inner);
          },
        },
      });
    }

    return pass(describePreferences(ctx.config));
  },
};
