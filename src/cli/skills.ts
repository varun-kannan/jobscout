import { defineCommand } from "citty";
import { writeFile } from "node:fs/promises";
import { getPaths, expand } from "../config/paths.ts";
import { loadConfigOrDefault } from "../config/load.ts";
import { openAndMigrate } from "../db/db.ts";
import { extractResume, resumeHeader, ResumeError } from "../profile/resume.ts";
import { buildProfile, loadProfile, removeSkill, setSkill, skillGaps } from "../skills/profile.ts";
import { SKILL_CATEGORIES } from "../skills/canonical.ts";
import { SKILL_LEVELS, type SkillLevel } from "../skills/match.ts";
import { AliasResolver } from "../skills/aliases.ts";
import { c, hint, line, ok, pad, warn } from "../output/theme.ts";
import { readFile } from "node:fs/promises";

const LEVEL_COLOUR: Record<SkillLevel, (s: string) => string> = {
  expert: c.green,
  strong: c.green,
  working: c.yellow,
  exposure: c.dim,
};

async function readIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export const skillsCommand = defineCommand({
  meta: {
    name: "skills",
    description: "Show, edit, or re-extract your skill profile",
  },
  args: {
    extract: { type: "boolean", description: "Rebuild the profile from your résumé", default: false },
    gaps: { type: "boolean", description: "Skills most in demand that you don't have", default: false },
    add: { type: "string", description: "Add or correct a skill (use with --level)" },
    level: { type: "string", description: `One of: ${SKILL_LEVELS.join(", ")}` },
    years: { type: "string", description: "Years of experience with the added skill" },
    remove: { type: "string", description: "Remove a skill from the profile" },
    root: { type: "string", description: "Data directory" },
  },

  async run({ args }) {
    const paths = getPaths(args.root as string | undefined);
    const config = await loadConfigOrDefault(paths);
    const db = await openAndMigrate(paths.db);

    try {
      /* ── edits ──────────────────────────────────────────────── */
      if (args.remove) {
        const slug = new AliasResolver().resolve(String(args.remove));
        const gone = slug ? removeSkill(db.raw, slug) : false;
        line(gone ? ok(`Removed ${slug}`) : warn(`No such skill: ${args.remove}`));
        return;
      }

      if (args.add) {
        const level = String(args.level ?? "working") as SkillLevel;
        if (!SKILL_LEVELS.includes(level)) {
          line(warn(`Unknown level "${level}". Use one of: ${SKILL_LEVELS.join(", ")}`));
          process.exitCode = 1;
          return;
        }
        const slug = new AliasResolver().resolve(String(args.add));
        if (!slug) {
          line(warn(`Could not read "${args.add}" as a skill.`));
          process.exitCode = 1;
          return;
        }
        const years = args.years ? Number(args.years) : undefined;
        setSkill(db.raw, { slug, level, years: Number.isFinite(years) ? years : undefined });
        line(ok(`${slug} set to ${level}${years ? `, ${years}y` : ""} ${c.dim("(pinned)")}`));
        line(hint("Pinned skills survive re-extraction."));
        return;
      }

      /* ── gaps ───────────────────────────────────────────────── */
      if (args.gaps) {
        const gaps = skillGaps(db.raw, 12);
        if (gaps.length === 0) {
          line(hint("No gaps yet — run `jobscout discover` and `jobscout match` first."));
          return;
        }
        const widest = gaps[0]!.jobs;
        line();
        line(c.bold("Most-demanded skills you don't have"));
        line();
        for (const gap of gaps) {
          const bar = "█".repeat(Math.max(1, Math.round((gap.jobs / widest) * 22)));
          line(`  ${pad(gap.label, 22)}${c.dim(bar)}  ${c.bold(String(gap.jobs))} jobs`);
        }
        line();
        line(hint(`Learning ${gaps[0]!.label} would move ${gaps[0]!.jobs} postings up your list.`));
        line();
        return;
      }

      /* ── extract ────────────────────────────────────────────── */
      if (args.extract) {
        const file = config.profile.resumeFile;
        if (!file) {
          line(warn("No résumé configured. Run `jobscout init` first."));
          process.exitCode = 1;
          return;
        }
        const path = expand(file);
        try {
          const extracted = await extractResume(path);
          await writeFile(
            paths.resumeText,
            resumeHeader(path.split("/").pop() ?? "resume") + extracted.text,
            "utf8",
          );
          line(ok(`Extracted ${extracted.words} words from ${extracted.format.toUpperCase()}`));
          if (extracted.suspect) {
            line(warn("That is very little text — check the file is not a scanned image."));
          }

          // Work history counts as evidence too; a skill described there but
          // squeezed off the résumé should still register.
          const extra = await readIfPresent(paths.workHistory);
          const result = buildProfile(db.raw, extracted.text, { extraText: extra });
          line(
            ok(
              `${result.skills.length} skills — ${result.added} new, ${result.updated} updated` +
                (result.kept ? `, ${result.kept} pinned kept` : ""),
            ),
          );
        } catch (err) {
          if (err instanceof ResumeError) {
            line(warn(err.message));
            if (err.hint) line(hint(`  ${err.hint}`));
            process.exitCode = 1;
            return;
          }
          throw err;
        }
      }

      /* ── show ───────────────────────────────────────────────── */
      const skills = loadProfile(db.raw);
      if (skills.length === 0) {
        line();
        line(warn("No skill profile yet."));
        line(hint("Run `jobscout skills --extract` to build one from your résumé."));
        line();
        return;
      }

      line();
      line(
        c.bold("Your skill profile") +
          c.dim(`  ·  ${skills.length} skills across ${new Set(skills.map((s) => s.category)).size} categories`),
      );
      line();

      for (const category of SKILL_CATEGORIES) {
        const inCategory = skills.filter((s) => s.category === category);
        if (inCategory.length === 0) continue;
        const rendered = inCategory.map((s) => {
          const colour = LEVEL_COLOUR[s.level];
          const years = s.years ? `${s.years}y ` : "";
          const pin = s.pinned ? c.dim("*") : "";
          return `${s.label} ${colour(`${years}${s.level}`)}${pin}`;
        });
        line(`  ${c.dim(pad(category.toUpperCase(), 11))}${rendered.join(c.dim("  ·  "))}`);
      }

      const withEvidence = skills.find((s) => s.evidence);
      if (withEvidence?.evidence) {
        line();
        line(c.dim(`  Evidence for "${withEvidence.label}":`));
        line(c.dim(`    ${withEvidence.evidence.slice(0, 150)}`));
      }
      if (skills.some((s) => s.pinned)) {
        line();
        line(hint("  * pinned by hand — survives re-extraction"));
      }
      line();
    } finally {
      db.close();
    }
  },
});
