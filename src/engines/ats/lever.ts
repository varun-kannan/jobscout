/**
 * Lever job boards.
 *
 * Keyless, one request per company, and it returns a plain-text description
 * alongside the HTML — so no unescaping guesswork. Notably good India coverage:
 * Meesho and CRED both resolve here.
 *
 * Docs: https://github.com/lever/postings-api
 */

import {
  clean,
  htmlToText,
  looksRemote,
  notReady,
  READY,
  type Engine,
  type EngineContext,
  type RawJob,
} from "../engine.ts";

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  description?: string;
  additionalPlain?: string;
  createdAt?: number;
  categories?: {
    location?: string;
    team?: string;
    commitment?: string;
    department?: string;
  };
}

export const lever: Engine = {
  id: "lever",
  family: "ats",
  label: "Lever",
  keyless: true,
  descriptionQuality: "full",

  ready(ctx) {
    return ctx.boards.length > 0
      ? READY
      : notReady("no Lever boards known yet — add some with `jobscout boards`");
  },

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const results: RawJob[] = [];

    for (const board of ctx.boards) {
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(
        board.token,
      )}?mode=json`;

      const data = await ctx.http.json<LeverPosting[]>(url, { signal: ctx.signal });
      // A token that does not exist returns an object, not an array.
      if (!Array.isArray(data)) continue;

      for (const post of data) {
        const location = clean(post.categories?.location);
        const title = clean(post.text);
        const body =
          post.descriptionPlain ?? htmlToText(post.description ?? "");
        const extra = post.additionalPlain ?? "";
        const description = [body, extra].filter(Boolean).join("\n\n").trim();

        results.push({
          nativeId: post.id,
          company: board.company,
          title,
          location,
          applyUrl: clean(post.applyUrl ?? post.hostedUrl),
          description,
          descriptionComplete: description.length > 0,
          remote: looksRemote(location, title),
          employmentType: clean(post.categories?.commitment) || null,
          postedAt: post.createdAt ? new Date(post.createdAt).toISOString() : null,
          raw: post,
        });
      }
    }

    return results;
  },
};
