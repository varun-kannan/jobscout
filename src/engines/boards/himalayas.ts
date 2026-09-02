/**
 * Himalayas.
 *
 * The richest metadata in this family by a distance. It returns structured
 * salary with currency and period, a seniority list, and — most valuably —
 * `locationRestrictions`, which states the "remote, but United States only"
 * catch as data instead of leaving it buried in the description.
 */

import {
  asArray,
  clean,
  htmlToText,
  READY,
  type Engine,
  type EngineContext,
  type RawJob,
} from "../engine.ts";
import { fromStructured, type SalaryPeriod } from "../../signals/salary.ts";
import { epochToIso, matchesTerms, withinAge } from "./filter.ts";

interface HimalayasJob {
  title?: string;
  excerpt?: string;
  description?: string;
  companyName?: string;
  companySlug?: string;
  employmentType?: string;
  minSalary?: number | null;
  maxSalary?: number | null;
  currency?: string | null;
  salaryPeriod?: string | null;
  seniority?: string[];
  locationRestrictions?: string[];
  timezoneRestrictions?: number[];
  categories?: string[];
  pubDate?: number;
  applicationLink?: string;
  guid?: string;
}

interface HimalayasResponse {
  jobs?: HimalayasJob[];
}

const LIMIT = 100;

function period(value: string | null | undefined): SalaryPeriod {
  if (value === "monthly" || value === "hourly") return value;
  return "annual";
}

/**
 * Turn the restriction list into a location string.
 *
 * An empty list means genuinely worldwide; a populated one means remote *but*,
 * and saying so plainly here is far more useful than the word "Remote".
 */
function locationOf(job: HimalayasJob): string {
  const restrictions = (job.locationRestrictions ?? []).map((r) => clean(r)).filter(Boolean);
  if (restrictions.length === 0) return "Remote (worldwide)";
  return `Remote (${restrictions.join(", ")})`;
}

export const himalayas: Engine = {
  id: "himalayas",
  family: "board",
  label: "Himalayas",
  keyless: true,
  descriptionQuality: "full",

  ready: () => READY,

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const data = await ctx.http.json<HimalayasResponse>(
      `https://himalayas.app/jobs/api?limit=${LIMIT}`,
      { signal: ctx.signal },
    );

    const results: RawJob[] = [];

    for (const job of asArray<HimalayasJob>(data.jobs)) {
      const link = clean(job.applicationLink ?? job.guid);
      if (!link) continue;

      const title = clean(job.title);
      const tags = (job.categories ?? []).map((c) => clean(c).replace(/-/g, " "));
      if (!matchesTerms(ctx.query.terms, { title, tags })) continue;

      const postedAt = epochToIso(job.pubDate);
      if (!withinAge(postedAt, ctx.query.maxAgeDays)) continue;

      const description = htmlToText(job.description ?? job.excerpt ?? "");

      results.push({
        // Himalayas exposes no numeric id, so the application link is the key.
        nativeId: link,
        company: clean(job.companyName),
        title,
        location: locationOf(job),
        applyUrl: link,
        description,
        descriptionComplete: description.length > 0,
        remote: true,
        salary: fromStructured({
          min: job.minSalary ?? null,
          max: job.maxSalary ?? null,
          currency: clean(job.currency) || "USD",
          period: period(job.salaryPeriod),
        }),
        employmentType: clean(job.employmentType) || null,
        postedAt,
        skills: tags,
        raw: job,
      });
    }

    return results;
  },
};
