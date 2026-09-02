/**
 * Recruitee job boards.
 *
 * The richest metadata of the six: it returns explicit `remote`, `hybrid` and
 * `on_site` booleans rather than leaving remote status to be inferred from a
 * location string, plus tags and a separate requirements section.
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

interface RecruiteeOffer {
  id: number;
  title?: string;
  slug?: string;
  description?: string;
  requirements?: string;
  location?: string;
  city?: string;
  country?: string;
  careers_url?: string;
  careers_apply_url?: string;
  employment_type_code?: string;
  published_at?: string;
  company_name?: string;
  tags?: string[];
  remote?: boolean;
  hybrid?: boolean;
  on_site?: boolean;
}

interface RecruiteeResponse {
  offers?: RecruiteeOffer[];
}

/** Prefer the source's own flags over guessing from a location string. */
function remoteOf(offer: RecruiteeOffer, location: string, title: string): boolean | null {
  // hybrid and on_site are separate flags, and either rules remote out.
  if (offer.on_site === true || offer.hybrid === true) return false;
  return remoteFrom(offer.remote, location, title);
}

export const recruitee: Engine = {
  id: "recruitee",
  family: "ats",
  label: "Recruitee",
  keyless: true,
  descriptionQuality: "full",

  ready(ctx) {
    return ctx.boards.length > 0
      ? READY
      : notReady("no Recruitee boards known yet — add some with `jobscout boards`");
  },

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const results: RawJob[] = [];

    for (const board of ctx.boards) {
      const url = `https://${encodeURIComponent(board.token)}.recruitee.com/api/offers/`;
      const data = await ctx.http.json<RecruiteeResponse>(url, { signal: ctx.signal });
      if (!data?.offers?.length) continue;

      for (const offer of asArray<RecruiteeOffer>(data.offers)) {
        const location = clean(offer.location) || clean(offer.city);
        const title = clean(offer.title);
        const description = [
          htmlToText(offer.description ?? ""),
          htmlToText(offer.requirements ?? ""),
        ]
          .filter(Boolean)
          .join("\n\n")
          .trim();

        results.push({
          nativeId: String(offer.id),
          company: clean(offer.company_name) || board.company,
          title,
          location,
          applyUrl: clean(offer.careers_apply_url ?? offer.careers_url),
          description,
          descriptionComplete: description.length > 0,
          remote: remoteOf(offer, location, title),
          employmentType: clean(offer.employment_type_code) || null,
          postedAt: offer.published_at ?? null,
          skills: offer.tags?.map((t) => clean(t)).filter(Boolean),
          raw: offer,
        });
      }
    }

    return results;
  },
};
