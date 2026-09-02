/**
 * Phase 3 — the résumé, and the placeholder detection that goes with it.
 *
 * The template check earns its place from a specific observed failure: in the
 * system this replaces, all three personal files sat untouched at their example
 * contents while the pipeline reported success. It would have written cover
 * letters signed "Your Name". Detecting unedited templates is cheap and kills a
 * whole category of silent garbage output.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import {
  caution,
  pass,
  problem,
  type Check,
  type CheckContext,
  type CheckResult,
} from "./check.ts";
import { expand } from "../../config/paths.ts";

const WORK_HISTORY_TEMPLATE = `<!--
Bullets beyond what fits on your résumé, so drafting can mix and match per role.
Write real ones — the placeholder text below is detected and refused.
-->

## Company — Role (YYYY–YYYY)
- Bullet 1
- Bullet 2
- Bullet 3
`;

const COVER_STYLE_TEMPLATE = `<!--
How your cover letters should sound. Tone, structure, things to avoid.
Written in your voice, not a template with slots.
-->

Keep it to three short paragraphs. Open with the specific thing about the role
that matches my background — no "I am writing to apply for". Close without
"I look forward to hearing from you".
`;

/**
 * Phrases that only appear in an unedited starter file, or in one copied from
 * somewhere else and never filled in.
 */
const PLACEHOLDER_MARKERS = [
  "bullet 1",
  "bullet 2",
  "company — role (yyyy",
  "company - role (yyyy",
  "your name",
  "lorem ipsum",
];

/** Collapse whitespace so trivial reformatting does not read as an edit. */
function normalise(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "") // guidance comments are not content
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

/**
 * Is this file still the template we shipped?
 *
 * Marker phrases alone are not enough: a template with no obvious placeholder
 * text — the cover-letter style file, for instance — passes every marker test
 * while being completely unedited. So the shipped template is compared directly,
 * which needs nothing from the user and cannot be fooled by reformatting.
 */
export function looksLikeTemplate(text: string, template?: string): boolean {
  const body = normalise(text);
  if (body.length < 40) return true;
  if (template && body === normalise(template)) return true;
  return PLACEHOLDER_MARKERS.some((marker) => body.includes(marker));
}

export const resumeCheck: Check = {
  id: "resume",
  title: "Résumé",
  phase: "profile",

  async run(ctx: CheckContext): Promise<CheckResult> {
    const configured = ctx.config.profile.resumeFile;

    if (!configured) {
      return problem("not set", {
        detail: ["jobscout needs your résumé to build a skill profile."],
        fix: {
          label: "Set the résumé path?",
          defaultYes: true,
          manual: true,
          instructions: [
            "Re-run `jobscout init` and answer the résumé question, or set it by hand:",
            "    [profile]",
            '    resumeFile = "~/Documents/your-cv.pdf"',
            `in ${ctx.paths.config}`,
          ],
        },
      });
    }

    const path = expand(configured);
    try {
      const info = await stat(path);
      if (!info.isFile()) return problem(`${path} is not a file`);
    } catch {
      return problem(`not found: ${path}`, {
        detail: ["The file may have moved. Re-run `jobscout init` to point at it again."],
      });
    }

    const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
    if (![".pdf", ".docx", ".txt", ".md"].includes(ext)) {
      return problem(`unsupported format: ${ext}`, {
        detail: ["Use .pdf, .docx, .txt, or .md."],
      });
    }

    return pass(path.split("/").pop() ?? path);
  },
};

/** Shared shape for the two Markdown profile files. */
function templateCheck(opts: {
  id: string;
  title: string;
  file: (ctx: CheckContext) => string;
  template: string;
  whyItMatters: string;
}): Check {
  return {
    id: opts.id,
    title: opts.title,
    phase: "profile",
    async run(ctx: CheckContext): Promise<CheckResult> {
      const path = opts.file(ctx);
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        return caution("not created yet", {
          fix: {
            label: `Create ${opts.title.toLowerCase()} from a starter template?`,
            defaultYes: true,
            async run() {
              await writeFile(path, opts.template, "utf8");
            },
          },
        });
      }

      if (looksLikeTemplate(text, opts.template)) {
        return caution("still the starter template", {
          detail: [opts.whyItMatters, `Edit ${path}`],
          fix: {
            label: "Open it in your editor now?",
            defaultYes: true,
            manual: true,
            instructions: [`    $EDITOR ${path}`, "Then re-run `jobscout init`."],
          },
        });
      }

      const words = text.split(/\s+/).filter(Boolean).length;
      return pass(`${words} words`);
    },
  };
}

export const workHistoryCheck = templateCheck({
  id: "work-history",
  title: "Work history",
  file: (ctx) => ctx.paths.workHistory,
  template: WORK_HISTORY_TEMPLATE,
  whyItMatters: "Cover letters will be generic without real bullets to draw from.",
});

export const coverStyleCheck = templateCheck({
  id: "cover-style",
  title: "Cover letter style",
  file: (ctx) => ctx.paths.coverLetterStyle,
  template: COVER_STYLE_TEMPLATE,
  whyItMatters: "Drafts will sound like a template until this describes your voice.",
});

export const profileChecks: Check[] = [resumeCheck, workHistoryCheck, coverStyleCheck];
