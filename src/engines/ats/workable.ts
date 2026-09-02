/**
 * Workable job boards.
 *
 * The public widget endpoint behind every Workable careers page. `details=true`
 * asks for full descriptions; without it only titles come back.
 *
 * Envelope shape verified live ({ name, description, jobs }); the per-job field
 * names follow Workable's published widget format.
 */

import {
  asArray,
  clean,
  htmlToText,
  remoteFrom,
  notReady,
  READY,
  type Engine,
  type EngineContext,
  type RawJob,
} from "../engine.ts";

interface WorkableJob {
  id?: string;
  shortcode?: string;
  title?: string;
  description?: string;
  requirements?: string;
  benefits?: string;
  url?: string;
  application_url?: string;
  employment_type?: string;
  published_on?: string;
  created_at?: string;
  telecommuting?: boolean;
  city?: string;
  state?: string;
  country?: string;
  location?: { city?: string; region?: string; country?: string; telecommuting?: boolean };
}

interface WorkableResponse {
  name?: string;
  description?: string;
  jobs?: WorkableJob[];
}

function locationOf(job: WorkableJob): string {
  const parts = job.location
    ? [job.location.city, job.location.region, job.location.country]
    : [job.city, job.state, job.country];
  return parts.map((p) => clean(p)).filter(Boolean).join(", ");
}

export const workable: Engine = {
  id: "workable",
  family: "ats",
  label: "Workable",
  keyless: true,
  descriptionQuality: "full",

  ready(ctx) {
    return ctx.boards.length > 0
      ? READY
      : notReady("no Workable boards known yet — add some with `jobscout boards`");
  },

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const results: RawJob[] = [];

    for (const board of ctx.boards) {
      const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(
        board.token,
      )}?details=true`;

      const data = await ctx.http.json<WorkableResponse>(url, { signal: ctx.signal });
      if (!data?.jobs?.length) continue;

      for (const job of asArray<WorkableJob>(data.jobs)) {
        const nativeId = clean(job.shortcode ?? job.id);
        if (!nativeId) continue;

        const location = locationOf(job);
        const title = clean(job.title);
        const description = [job.description, job.requirements, job.benefits]
          .filter(Boolean)
          .map((part) => htmlToText(part!))
          .filter(Boolean)
          .join("\n\n")
          .trim();

        const telecommuting = job.telecommuting ?? job.location?.telecommuting;

        results.push({
          nativeId,
          company: clean(data.name) || board.company,
          title,
          location,
          applyUrl: clean(job.application_url ?? job.url),
          description,
          descriptionComplete: description.length > 0,
          remote: remoteFrom(telecommuting, location, title),
          employmentType: clean(job.employment_type) || null,
          postedAt: job.published_on ?? job.created_at ?? null,
          raw: job,
        });
      }
    }

    return results;
  },
};
