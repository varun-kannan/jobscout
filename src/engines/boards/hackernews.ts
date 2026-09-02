/**
 * Hacker News "Ask HN: Who is hiring?".
 *
 * Structurally unlike every other engine: there is no jobs API, only a monthly
 * thread where each top-level comment is one company's posting. Reaching it
 * takes two steps through Algolia's public HN index — find the newest thread by
 * the `whoishiring` account, then page its comments.
 *
 * Two details that are easy to get wrong:
 *   - Sorting by relevance returns threads from 2016. It must be sorted by date.
 *   - Most comments are replies, not postings. A posting is identified by
 *     `parent_id === story_id`; a live page had 5 of 20 qualify.
 *
 * Postings follow a convention rather than a schema:
 *     Company | Role | LOCATION | SALARY | url
 * so the header is parsed defensively and the whole comment is always kept as
 * the description.
 */

import {
  asArray,
  clean,
  htmlToText,
  looksRemote,
  READY,
  type Engine,
  type EngineContext,
  type RawJob,
} from "../engine.ts";
import { parseSalary } from "../../signals/salary.ts";
import { matchesTerms } from "./filter.ts";

const ALGOLIA = "https://hn.algolia.com/api/v1";
const COMMENT_PAGES = 3;
const PER_PAGE = 100;

interface Hit {
  objectID: string;
  title?: string;
  author?: string;
  comment_text?: string;
  parent_id?: number;
  story_id?: number;
  created_at?: string;
}

interface SearchResponse {
  hits?: Hit[];
}

/** The newest "Who is hiring?" thread, excluding "Who wants to be hired?". */
async function latestThread(ctx: EngineContext): Promise<Hit | null> {
  const data = await ctx.http.json<SearchResponse>(
    `${ALGOLIA}/search_by_date?tags=story,author_whoishiring&hitsPerPage=10`,
    { signal: ctx.signal },
  );
  const hiring = asArray<Hit>(data.hits).filter((h) => {
    const title = (h.title ?? "").toLowerCase();
    return title.includes("who is hiring") && !title.includes("wants to be hired");
  });
  return hiring[0] ?? null;
}

/**
 * Pull company, role and location out of the conventional pipe-delimited
 * header. Every field is optional — the convention is widely but not
 * universally followed, so nothing here may throw or discard a posting.
 */
function parseHeader(text: string): { company: string; title: string; location: string } {
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const parts = firstLine
    .split("|")
    .map((p) => clean(p))
    .filter(Boolean);

  if (parts.length === 0) {
    return { company: "", title: clean(firstLine).slice(0, 120), location: "" };
  }

  const company = parts[0] ?? "";
  // Locations are conventionally uppercase (ONSITE NYC, REMOTE) and salary
  // segments contain a currency figure — neither belongs in the role name.
  const rest = parts.slice(1);
  const locationPart = rest.find((p) => /\b(remote|onsite|on-site|hybrid)\b/i.test(p)) ?? "";
  const titlePart = rest.find((p) => p !== locationPart && !/[$£€₹]\s?\d/.test(p)) ?? "";

  return {
    company,
    title: titlePart || company,
    location: locationPart,
  };
}

export const hackernews: Engine = {
  id: "hackernews",
  family: "board",
  label: "Hacker News",
  keyless: true,
  descriptionQuality: "full",

  ready: () => READY,

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const thread = await latestThread(ctx);
    if (!thread) return [];

    const storyId = Number(thread.objectID);
    const results: RawJob[] = [];

    for (let page = 0; page < COMMENT_PAGES; page++) {
      const data = await ctx.http.json<SearchResponse>(
        `${ALGOLIA}/search_by_date?tags=comment,story_${storyId}&hitsPerPage=${PER_PAGE}&page=${page}`,
        { signal: ctx.signal },
      );

      const hits = asArray<Hit>(data.hits);
      if (hits.length === 0) break;

      for (const hit of hits) {
        // Replies are conversation, not postings.
        if (hit.parent_id !== storyId) continue;

        const text = htmlToText(hit.comment_text ?? "");
        if (text.length < 40) continue;

        const { company, title, location } = parseHeader(text);
        if (!matchesTerms(ctx.query.terms, { title: `${title} ${company}` })) continue;

        results.push({
          nativeId: hit.objectID,
          company,
          title,
          location,
          applyUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          description: text,
          descriptionComplete: true,
          remote: looksRemote(location, title),
          // HN postings state pay far more often than job boards do.
          salary: parseSalary(text),
          postedAt: hit.created_at ?? null,
          raw: { ...hit, thread: thread.title },
        });
      }
    }

    return results;
  },
};
