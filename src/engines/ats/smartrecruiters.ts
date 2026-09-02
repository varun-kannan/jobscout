/**
 * SmartRecruiters job boards.
 *
 * Two requests per job rather than one: the postings list carries titles and
 * locations only, and the full description lives behind a per-posting call. To
 * keep a board from costing hundreds of requests, only the first page is
 * listed and descriptions are fetched with bounded concurrency.
 *
 * Envelope shape verified live ({ offset, limit, totalFound, content }). There
 * is no global search endpoint — postings are per-company only.
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
import { mapLimit } from "../concurrency.ts";

const PAGE_SIZE = 100;
/** Detail requests in flight at once, per board. */
const DETAIL_CONCURRENCY = 6;

interface SrPosting {
  id: string;
  name?: string;
  ref?: string;
  releasedDate?: string;
  company?: { name?: string };
  location?: { city?: string; region?: string; country?: string; remote?: boolean };
  typeOfEmployment?: { label?: string };
}

interface SrListResponse {
  totalFound?: number;
  content?: SrPosting[];
}

interface SrDetail {
  jobAd?: {
    sections?: Record<string, { title?: string; text?: string } | undefined>;
  };
}

function locationOf(post: SrPosting): string {
  return [post.location?.city, post.location?.region, post.location?.country]
    .map((p) => clean(p))
    .filter(Boolean)
    .join(", ");
}

export const smartrecruiters: Engine = {
  id: "smartrecruiters",
  family: "ats",
  label: "SmartRecruiters",
  keyless: true,
  descriptionQuality: "full",

  ready(ctx) {
    return ctx.boards.length > 0
      ? READY
      : notReady("no SmartRecruiters boards known yet — add some with `jobscout boards`");
  },

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const results: RawJob[] = [];

    for (const board of ctx.boards) {
      const company = encodeURIComponent(board.token);
      const list = await ctx.http.json<SrListResponse>(
        `https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=${PAGE_SIZE}`,
        { signal: ctx.signal },
      );

      const postings = asArray<SrPosting>(list?.content);
      if (postings.length === 0) continue;

      const descriptions = await mapLimit(postings, DETAIL_CONCURRENCY, async (post) => {
        try {
          const detail = await ctx.http.json<SrDetail>(
            `https://api.smartrecruiters.com/v1/companies/${company}/postings/${encodeURIComponent(post.id)}`,
            { signal: ctx.signal, retries: 1 },
          );
          const sections = detail?.jobAd?.sections ?? {};
          return Object.values(sections)
            .map((section) => htmlToText(section?.text ?? ""))
            .filter(Boolean)
            .join("\n\n")
            .trim();
        } catch {
          // One posting failing to expand must not lose the whole board.
          return "";
        }
      });

      postings.forEach((post, index) => {
        const location = locationOf(post);
        const title = clean(post.name);
        const description = descriptions[index] ?? "";

        results.push({
          nativeId: post.id,
          company: clean(post.company?.name) || board.company,
          title,
          location,
          applyUrl: `https://jobs.smartrecruiters.com/${board.token}/${post.id}`,
          description,
          descriptionComplete: description.length > 0,
          remote: remoteFrom(post.location?.remote, location, title),
          employmentType: clean(post.typeOfEmployment?.label) || null,
          postedAt: post.releasedDate ?? null,
          raw: post,
        });
      });
    }

    return results;
  },
};
