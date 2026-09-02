/**
 * RemoteOK.
 *
 * Returns roughly 100 recent remote postings in one keyless call, with full
 * HTML descriptions and tags. Two quirks worth knowing: the first array element
 * is a legal notice rather than a job, and salary fields are present but almost
 * always zero — a live check found 1 of 99 with a real figure.
 */

import {
  clean,
  htmlToText,
  READY,
  type Engine,
  type EngineContext,
  type RawJob,
} from "../engine.ts";
import { fromStructured } from "../../signals/salary.ts";
import { epochToIso, matchesTerms, withinAge } from "./filter.ts";

interface RemoteOkRow {
  id?: number | string;
  slug?: string;
  position?: string;
  company?: string;
  location?: string;
  description?: string;
  url?: string;
  apply_url?: string;
  date?: string;
  epoch?: number;
  tags?: string[];
  salary_min?: number;
  salary_max?: number;
  /** Present only on the leading legal-notice element. */
  legal?: string;
}

export const remoteok: Engine = {
  id: "remoteok",
  family: "board",
  label: "RemoteOK",
  keyless: true,
  descriptionQuality: "full",

  ready: () => READY,

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const rows = await ctx.http.json<RemoteOkRow[]>("https://remoteok.com/api", {
      signal: ctx.signal,
    });
    if (!Array.isArray(rows)) return [];

    const results: RawJob[] = [];

    for (const row of rows) {
      // The API leads with a legal notice object; it has no position field.
      if (row.legal !== undefined || !row.position) continue;

      const title = clean(row.position);
      const tags = (row.tags ?? []).map((t) => clean(t)).filter(Boolean);
      if (!matchesTerms(ctx.query.terms, { title, tags })) continue;

      const postedAt = clean(row.date) || epochToIso(row.epoch);
      if (!withinAge(postedAt, ctx.query.maxAgeDays)) continue;

      const description = htmlToText(row.description ?? "");
      // Zero is RemoteOK's "not disclosed", not a real salary.
      const salary = fromStructured({
        min: row.salary_min && row.salary_min > 0 ? row.salary_min : null,
        max: row.salary_max && row.salary_max > 0 ? row.salary_max : null,
        currency: "USD",
      });

      results.push({
        nativeId: String(row.id ?? row.slug ?? ""),
        company: clean(row.company),
        title,
        location: clean(row.location) || "Remote",
        applyUrl: clean(row.apply_url ?? row.url),
        description,
        descriptionComplete: description.length > 0,
        remote: true, // the entire board is remote-only
        salary,
        postedAt,
        skills: tags,
        raw: row,
      });
    }

    return results;
  },
};
