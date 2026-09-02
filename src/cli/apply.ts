/**
 * `jobscout apply` — open each prepared job and stage its materials.
 *
 * This opens a browser tab, copies the cover letter to the clipboard, and
 * prints the screening answers. That is the whole of it.
 *
 * It does not fill a form, click a control, or submit anything — and cannot:
 * there is no browser-automation library anywhere in the dependency tree, so
 * the tool has no means of touching the page it opened. The two remaining
 * steps are yours on purpose. Automating the autofill would mean driving a
 * third-party extension; automating the submit would remove the only review
 * gate between a draft and a real application.
 */

import { defineCommand } from "citty";
import { join } from "node:path";
import clipboard from "clipboardy";
import { getPaths } from "../config/paths.ts";
import { openAndMigrate } from "../db/db.ts";
import { listByStatus, setStatus } from "../db/applications.ts";
import { c, hint, line, ok, warn } from "../output/theme.ts";

/** Open a URL in the default browser. Never interacts with the page. */
async function openInBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const proc = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

/** Wait for the user to press enter. */
async function waitForEnter(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  for await (const chunk of Bun.stdin.stream()) {
    return new TextDecoder().decode(chunk).trim();
  }
  return "";
}

export const applyCommand = defineCommand({
  meta: {
    name: "apply",
    description: "Open each prepared job and stage its materials — you submit",
  },
  args: {
    // Declared positively: citty turns `--no-open` into `open: false`, so a
    // flag named "no-open" is parsed as a negation and never reads as true.
    open: {
      type: "boolean",
      description: "Open each job in your browser (--no-open to skip)",
      default: true,
    },
    root: { type: "string", description: "Data directory" },
  },

  async run({ args }) {
    const paths = getPaths(args.root as string | undefined);
    const db = await openAndMigrate(paths.db);

    try {
      const pending = listByStatus(db.raw, "prepared");
      if (pending.length === 0) {
        line();
        line(warn("Nothing prepared."));
        line(hint("  Approve jobs with `jobscout review`, then run `jobscout prepare`."));
        line();
        return;
      }

      const interactive = process.stdin.isTTY === true;
      line();
      line(`${pending.length} job(s) ready. ${c.dim("You fill the form, review it, and submit.")}`);
      line();

      let submitted = 0;

      for (const [index, app] of pending.entries()) {
        const outDir = join(paths.outbox, app.jobId);
        line(
          `${c.bold(`[${index + 1}/${pending.length}]`)} ${c.cyan(app.company)} — ${app.title}`,
        );

        if (args.open === false) {
          line(`  ${c.dim(app.applyUrl)}`);
        } else if (app.applyUrl) {
          const opened = await openInBrowser(app.applyUrl);
          line(opened ? `  ${ok("opened in your browser")}` : `  ${c.dim(app.applyUrl)}`);
        } else {
          line(`  ${warn("no apply link recorded")}`);
        }

        const cover = await readIfPresent(join(outDir, "cover_letter_final.md"));
        if (cover) {
          try {
            await clipboard.write(cover);
            line(`  ${ok("cover letter on your clipboard")} ${c.dim("— paste with Cmd+V")}`);
          } catch {
            line(`  ${c.dim(`cover letter: ${join(outDir, "cover_letter_final.md")}`)}`);
          }
        }

        const answers = await readIfPresent(join(outDir, "answers_final.md"));
        if (answers?.trim()) {
          line();
          line(c.dim("  ── screening answers ──"));
          for (const l of answers.trim().split("\n")) line(`  ${l}`);
        }

        const missing = await readIfPresent(join(outDir, "MISSING.md"));
        if (missing?.trim()) {
          line();
          line(`  ${warn("this posting asks for things your profile does not contain:")}`);
          for (const l of missing.split("\n").filter((x) => x.startsWith("- "))) {
            line(`    ${c.yellow(l)}`);
          }
        }

        const note = await readIfPresent(join(outDir, "REVIEW_NOTE.md"));
        if (note?.trim()) {
          const body = note.split("\n").find((l) => l.startsWith("> "));
          if (body) line(`  ${c.magenta("✎")} ${c.dim(body.slice(2))}`);
        }

        line();
        line(`  ${c.dim("→ autofill, paste, ")}${c.bold("review")}${c.dim(", then submit yourself.")}`);

        if (!interactive) {
          line();
          continue;
        }

        const answer = await waitForEnter(
          c.dim(`  [enter] next · [s] mark submitted · [q] stop  `),
        );
        if (answer === "q") {
          line();
          break;
        }
        if (answer === "s") {
          setStatus(db.raw, app.jobId, "submitted");
          submitted++;
          line(`  ${ok("marked submitted")}`);
        }
        line();
      }

      if (submitted > 0) {
        line(`  ${c.green(`${submitted} marked submitted`)}`);
      } else if (interactive) {
        line(hint("  Mark what you sent with `jobscout status --submitted <company>`."));
      }
      line();
    } finally {
      db.close();
    }
  },
});
