import { defineCommand } from "citty";
import { getPaths } from "../config/paths.ts";
import { openAndMigrate } from "../db/db.ts";
import { activeBoards, addBoard } from "../db/jobs.ts";
import { createHttpClient } from "../engines/http.ts";
import {
  probeCompanies,
  probeCompany,
  verifyBoard,
  type ProbeResult,
} from "../engines/discover-boards.ts";
import { c, hint, line, ok, pad, skip, warn } from "../output/theme.ts";

/**
 * Companies worth probing.
 *
 * Drawn from postings already discovered whose employer has no known board —
 * exactly the gap board discovery exists to close. Ordered by how many postings
 * each company has, so the highest-yield tokens are found first.
 */
function companiesWithoutBoards(db: ReturnType<typeof openAndMigrate> extends Promise<infer T> ? T : never, limit: number): string[] {
  return db.raw
    .query<{ company: string; n: number }, [number]>(
      `SELECT j.company AS company, COUNT(*) AS n
       FROM jobs j
       WHERE j.company <> ''
         AND LOWER(REPLACE(j.company, ' ', '')) NOT IN (
           SELECT LOWER(REPLACE(b.company, ' ', '')) FROM boards b
         )
       GROUP BY j.company
       ORDER BY n DESC
       LIMIT ?`,
    )
    .all(limit)
    .map((r) => r.company);
}

export const boardsCommand = defineCommand({
  meta: {
    name: "boards",
    description: "Find and manage the company boards the ATS engines poll",
  },
  args: {
    discover: {
      type: "boolean",
      description: "Probe companies from your postings for a board",
      default: false,
    },
    add: { type: "string", description: "Probe one company by name" },
    verify: { type: "boolean", description: "Re-check known boards, dropping stale ones", default: false },
    limit: { type: "string", description: "How many companies to probe (default 25)" },
    root: { type: "string", description: "Data directory" },
  },

  async run({ args }) {
    const paths = getPaths(args.root as string | undefined);
    const db = await openAndMigrate(paths.db);
    const http = createHttpClient();

    try {
      /* — add one company by name — */
      if (args.add) {
        const company = String(args.add);
        line();
        line(c.dim(`Probing ${company}…`));
        const found = await probeCompany(company, { http });
        if (!found) {
          line(warn(`No board found for "${company}".`));
          line(hint("  It may use a platform jobscout cannot probe, or a token unlike its name."));
          process.exitCode = 1;
          return;
        }
        const { added } = addBoard(db.raw, { ...found, verified: true });
        line(
          ok(`${found.company} → ${found.ats}/${found.token} (${found.jobs} jobs)`) +
            (added ? "" : c.dim("  already known")),
        );
        line();
        return;
      }

      /* — re-check what is already known — */
      if (args.verify) {
        const boards = activeBoards(db.raw);
        if (boards.length === 0) {
          line();
          line(warn("No boards to verify."));
          line();
          return;
        }

        line();
        line(c.dim(`Verifying ${boards.length} board(s)…`));
        const deactivate = db.raw.prepare(`UPDATE boards SET active = 0 WHERE ats = ? AND token = ?`);
        const stamp = db.raw.prepare(
          `UPDATE boards SET verified_at = ? WHERE ats = ? AND token = ?`,
        );

        let alive = 0;
        let dropped = 0;
        for (const board of boards) {
          const okNow = await verifyBoard(board, { http });
          if (okNow) {
            stamp.run(new Date().toISOString(), board.ats, board.token);
            alive++;
          } else {
            // Companies move between platforms; a token that stops resolving
            // is deactivated rather than deleted, so it can be revived.
            deactivate.run(board.ats, board.token);
            dropped++;
            line(`  ${skip(`${pad(board.company, 22)}${board.ats}/${board.token} no longer resolves`)}`);
          }
        }
        line();
        line(`  ${c.green(`${alive} healthy`)}${dropped ? c.yellow(` · ${dropped} deactivated`) : ""}`);
        line();
        return;
      }

      /* — discover from the corpus — */
      if (args.discover) {
        const limit = Number(args.limit ?? 25);
        const companies = companiesWithoutBoards(db, Number.isFinite(limit) ? limit : 25);

        if (companies.length === 0) {
          line();
          line(ok("Every company in your postings already has a board."));
          line();
          return;
        }

        line();
        line(c.dim(`Probing ${companies.length} companies across 4 platforms…`));
        line();

        const found: ProbeResult[] = [];
        const summary = await probeCompanies(companies, {
          http,
          onProgress(company, index, total) {
            // Carriage returns only overwrite on a terminal; piped output
            // would otherwise show every step concatenated on one line.
            if (!process.stdout.isTTY) return;
            process.stdout.write(`\r  ${c.dim(`[${index}/${total}]`)} ${pad(company.slice(0, 40), 41)}`);
          },
        });
        if (process.stdout.isTTY) process.stdout.write("\r" + " ".repeat(60) + "\r");

        for (const result of summary.found) {
          const { added } = addBoard(db.raw, { ...result, verified: true });
          if (added) found.push(result);
          line(
            `  ${ok(`${pad(result.company.slice(0, 24), 25)}${pad(`${result.ats}/${result.token}`, 30)}${result.jobs} jobs`)}`,
          );
        }

        line();
        line(
          `  ${c.bold(String(found.length))} new board(s) from ${summary.tried} companies` +
            c.dim(`  ·  ${summary.missed.length} not found`),
        );
        if (found.length > 0) line(hint("  Run `jobscout discover` to pull from them."));
        line();
        return;
      }

      /* — list — */
      const boards = activeBoards(db.raw);
      line();
      if (boards.length === 0) {
        line(warn("No boards known."));
        line(hint("  Run `jobscout boards --discover` to find some from your postings."));
        line();
        return;
      }

      const byAts = new Map<string, typeof boards>();
      for (const board of boards) {
        byAts.set(board.ats, [...(byAts.get(board.ats) ?? []), board]);
      }
      for (const [ats, list] of [...byAts].sort()) {
        line(`  ${c.bold(ats)} ${c.dim(`(${list.length})`)}`);
        for (const board of list) {
          line(`    ${pad(board.company.slice(0, 28), 29)}${c.dim(board.token)}`);
        }
      }
      line();
      line(c.dim(`  ${boards.length} board(s) across ${byAts.size} platform(s)`));
      line();
    } finally {
      db.close();
    }
  },
});
