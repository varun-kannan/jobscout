/**
 * Greenhouse job boards.
 *
 * The best-shaped source in the roster: one keyless request per company returns
 * every open role with the complete description. A live check against Stripe's
 * board returned 583 jobs averaging ~5,000 characters of content.
 *
 * Docs: https://developers.greenhouse.io/job-board.html
 */

import {
  asArray,
  clean,
  htmlToText,
  looksRemote,
  notReady,
  READY,
  type Engine,
  type EngineContext,
  type RawJob,
} from "../engine.ts";

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  content: string;
  updated_at?: string;
  first_published?: string;
  company_name?: string;
  location?: { name?: string };
  metadata?: unknown;
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[];
}

export const greenhouse: Engine = {
  id: "greenhouse",
  family: "ats",
  label: "Greenhouse",
  keyless: true,
  descriptionQuality: "full",

  ready(ctx) {
    return ctx.boards.length > 0
      ? READY
      : notReady("no Greenhouse boards known yet — add some with `jobscout boards`");
  },

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const results: RawJob[] = [];

    for (const board of ctx.boards) {
      // content=true asks for the full posting body rather than titles alone.
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(
        board.token,
      )}/jobs?content=true`;

      const data = await ctx.http.json<GreenhouseResponse>(url, { signal: ctx.signal });
      if (!data?.jobs?.length) continue;

      for (const job of asArray<GreenhouseJob>(data.jobs)) {
        const location = clean(job.location?.name);
        const title = clean(job.title);
        // Greenhouse returns HTML-escaped HTML, so it needs unescaping twice.
        const description = htmlToText(htmlToText(job.content ?? ""));

        results.push({
          nativeId: String(job.id),
          company: clean(job.company_name) || board.company,
          title,
          location,
          applyUrl: clean(job.absolute_url),
          description,
          descriptionComplete: description.length > 0,
          remote: looksRemote(location, title),
          postedAt: job.first_published ?? job.updated_at ?? null,
          raw: job,
        });
      }
    }

    return results;
  },
};
