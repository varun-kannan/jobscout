/**
 * Ashby job boards.
 *
 * Two requests per posting rather than one. The board query returns
 * `JobPostingBriefsWithIdsAndTeamId` — id, title, location, employment type —
 * and has no description field at all; the body lives on `JobPostingDetails`
 * behind a per-posting query. Asking the board query for `descriptionHtml`
 * fails validation, which is how this engine first appeared to return "empty".
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
import { mapLimit } from "../concurrency.ts";

const ENDPOINT = "https://jobs.ashbyhq.com/api/non-user-graphql";

/** Detail requests in flight at once, per board. */
const DETAIL_CONCURRENCY = 6;

const BOARD_QUERY = `
query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
  jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
    jobPostings { id title locationName employmentType }
  }
}`;

const DETAIL_QUERY = `
query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(
    organizationHostedJobsPageName: $organizationHostedJobsPageName
    jobPostingId: $jobPostingId
  ) { id descriptionHtml }
}`;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface Brief {
  id: string;
  title?: string;
  locationName?: string;
  employmentType?: string;
}

/**
 * GraphQL reports failures as HTTP 200 with an `errors` array, so a bad query
 * looks exactly like a board with no jobs. Throwing here is what makes the
 * difference show up as `error` rather than `empty` in the run log.
 */
function unwrap<T>(response: GraphQLResponse<T>, what: string): T {
  if (response.errors?.length) {
    throw new Error(`Ashby ${what}: ${response.errors.map((e) => e.message).join("; ")}`);
  }
  if (!response.data) throw new Error(`Ashby ${what}: no data returned`);
  return response.data;
}

async function post<T>(ctx: EngineContext, op: string, query: string, variables: object) {
  return ctx.http.json<GraphQLResponse<T>>(`${ENDPOINT}?op=${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: ctx.signal,
    body: JSON.stringify({ operationName: op, variables, query }),
  });
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
      : notReady("no Ashby boards known yet — add some with `jobscout boards`");
  },

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const results: RawJob[] = [];

    for (const board of ctx.boards) {
      const boardData = unwrap(
        await post<{ jobBoard: { jobPostings?: Brief[] } | null }>(
          ctx,
          "ApiJobBoardWithTeams",
          BOARD_QUERY,
          { organizationHostedJobsPageName: board.token },
        ),
        `board "${board.token}"`,
      );

      const briefs = asArray<Brief>(boardData.jobBoard?.jobPostings);
      if (briefs.length === 0) continue;

      const descriptions = await mapLimit(briefs, DETAIL_CONCURRENCY, async (brief) => {
        try {
          const detail = unwrap(
            await post<{ jobPosting: { descriptionHtml?: string } | null }>(
              ctx,
              "ApiJobPosting",
              DETAIL_QUERY,
              {
                organizationHostedJobsPageName: board.token,
                jobPostingId: brief.id,
              },
            ),
            `posting ${brief.id}`,
          );
          return htmlToText(detail.jobPosting?.descriptionHtml ?? "");
        } catch {
          // One posting failing to expand must not lose the whole board.
          return "";
        }
      });

      briefs.forEach((brief, index) => {
        const location = clean(brief.locationName);
        const title = clean(brief.title);
        const description = descriptions[index] ?? "";

        results.push({
          nativeId: brief.id,
          company: board.company,
          title,
          location,
          applyUrl: `https://jobs.ashbyhq.com/${board.token}/${brief.id}`,
          description,
          descriptionComplete: description.length > 0,
          remote: looksRemote(location, title),
          employmentType: clean(brief.employmentType) || null,
          postedAt: null,
          raw: brief,
        });
      });
    }

    return results;
  },
};
