/**
 * `jobscout check` — which of these postings are still open?
 *
 * Everything here is HTTP: no model is asked anything, so a full pass costs
 * nothing but time and politeness.
 */

import { defineCommand } from "citty";
import { getPaths } from "../config/paths.ts";
import { openAndMigrate } from "../db/db.ts";
import { checkLiveness } from "../crawl/check.ts";
import { c, hint, line, pad } from "../output/theme.ts";

export const checkCommand = defineCommand({
  meta: { name: "check", description: "Find out which postings are still open" },
  args: {
    limit: { type: "string", description: "Most postings to check (default 500)" },
    location: { type: "string", description: "Only postings whose location contains this" },
    "older-than": { type: "string", description: "Only postings older than N days" },
    "recheck-after": { type: "string", description: "Skip anything checked in the last N days (default 7)" },
    "per-second": { type: "string", description: "Requests per second per host (default 1)" },
    all: { type: "boolean", description: "Re-check closed postings too", default: false },
    root: { type: "string", description: "Data directory" },
  },

  async run({ args }) {
    const paths = getPaths(args.root as string | undefined);
    const db = await openAndMigrate(paths.db);

    try {
      const limit = Number(args.limit ?? 500);
      const perSecond = Number(args["per-second"] ?? 1);
      const olderThan = args["older-than"] ? Number(args["older-than"]) : undefined;
      const recheckAfter = Number(args["recheck-after"] ?? 7);

      line();
      line(c.dim(`Checking up to ${limit} postings at ${perSecond}/sec per host…`));
      line(hint("  robots.txt is respected; a site that disallows us is reported as unreachable."));
      line();

      let lastShown = 0;
      const summary = await checkLiveness(db.raw, {
        limit: Number.isFinite(limit) ? limit : 500,
        location: args.location as string | undefined,
        olderThanDays: Number.isFinite(olderThan!) ? olderThan : undefined,
        recheckAfterDays: Number.isFinite(recheckAfter) ? recheckAfter : 7,
        includeClosed: Boolean(args.all),
        crawler: {
          db: db.raw,
          perSecond: Number.isFinite(perSecond) ? perSecond : 1,
          // A little over the row limit, because robots.txt costs a request per
          // host and a run should not stop just short of finishing.
          maxRequests: (Number.isFinite(limit) ? limit : 500) + 100,
        },
        onProgress(done, total, company, state) {
          // One line per ten, so a long run shows progress without scrolling.
          if (done - lastShown >= 10 || done === total) {
            lastShown = done;
            line(c.dim(`  ${pad(String(done), 5)}/${total}  ${pad(company.slice(0, 22), 24)}${state}`));
          }
        },
      });

      line();
      if (summary.considered === 0) {
        line(hint("  Nothing to check — everything has been looked at recently."));
        line();
        return;
      }

      const { counts } = summary;
      line(`  ${c.bold(String(summary.checked))} checked of ${summary.considered} considered`);
      line();
      for (const [state, label] of [
        ["open", "still open"],
        ["closed", "closed"],
        ["gone", "removed"],
        ["unreachable", "could not check"],
      ] as const) {
        const n = counts[state];
        if (n > 0) line(`    ${pad(String(n), 6)} ${label}`);
      }

      if (counts.unreachable > 0) {
        line();
        line(hint("  Unreachable is not closed. LinkedIn disallows crawlers and some boards"));
        line(hint("  block us, so those postings are left exactly as they were."));
      }
      if (summary.budgetExhausted) {
        line();
        line(hint("  Stopped at the request budget. Run it again to continue."));
      }
      line();
    } finally {
      db.close();
    }
  },
});
