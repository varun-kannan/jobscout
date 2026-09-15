/**
 * Ashby job boards, through Ashby's public posting API.
 *
 * One request per board returns every listed posting with its description,
 * publish date and remote flag. The previous engine used the GraphQL endpoint
 * behind the hosted pages, which has no description on the board query, so it
 * sent one extra request per posting. At seven boards that was around 400
 * requests in a burst, and Ashby answered every run with HTTP 429.
 *
 * Posting IDs are the same in both APIs, so stored jobs update in place.
 */

import {
  asArray,
  BoardErrors,
  clean,
  htmlToText,
  notReady,
  READY,
  remoteFrom,
  type Engine,
  type EngineContext,
  type RawJob,
} from "../engine.ts";

const ENDPOINT = "https://api.ashbyhq.com/posting-api/job-board";

interface AshbyPosting {
  id: string;
  title?: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  isRemote?: boolean;
  isListed?: boolean;
  employmentType?: string;
  publishedAt?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  jobUrl?: string;
}

interface AshbyBoard {
  jobs?: AshbyPosting[];
}

/**
 * Primary and secondary locations together. A role based in Bangalore that
 * also hires in Chennai lists Chennai only as a secondary location, and a
 * location filter or sort that saw the primary alone would miss it.
 */
function locationsOf(posting: AshbyPosting): string {
  const all = [
    clean(posting.location),
    ...asArray<{ location?: string }>(posting.secondaryLocations).map((s) => clean(s.location)),
  ].filter(Boolean);
  return [...new Set(all)].join("; ");
}

export const ashby: Engine = {
  id: "ashby",
  family: "ats",
  label: "Ashby",
  keyless: true,
  descriptionQuality: "full",

  ready(ctx) {
    return ctx.boards.length > 0
      ? READY
      : notReady("no Ashby boards known yet; add some with `jobscout boards`");
  },

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const results: RawJob[] = [];
    const errors = new BoardErrors(ctx.boards.length);

    for (const board of ctx.boards) {
      let data: AshbyBoard;
      try {
        data = await ctx.http.json<AshbyBoard>(
          `${ENDPOINT}/${encodeURIComponent(board.token)}`,
          { signal: ctx.signal },
        );
      } catch (err) {
        errors.record(err);
        continue;
      }

      for (const posting of asArray<AshbyPosting>(data?.jobs)) {
        if (!posting?.id || posting.isListed === false) continue;

        const location = locationsOf(posting);
        const title = clean(posting.title);
        const description =
          clean(posting.descriptionPlain) ? posting.descriptionPlain!.trim()
          : htmlToText(posting.descriptionHtml ?? "");

        results.push({
          nativeId: posting.id,
          company: board.company,
          title,
          location,
          applyUrl: clean(posting.jobUrl) || `https://jobs.ashbyhq.com/${board.token}/${posting.id}`,
          description,
          descriptionComplete: description.length > 0,
          remote: remoteFrom(posting.isRemote, location, title),
          employmentType: clean(posting.employmentType) || null,
          postedAt: posting.publishedAt ?? null,
          raw: posting,
        });
      }
    }

    errors.throwIfAllFailed();
    return results;
  },
};
