/**
 * Finalising approved jobs into the outbox.
 *
 * Moves a job's drafted materials from `drafts/{id}/` to `outbox/{id}/` and
 * opens an application record. Deliberately a copy rather than a move: if
 * anything downstream goes wrong, the draft is still there to fall back on.
 *
 * Nothing here talks to a job board.
 */

import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Paths } from "../config/paths.ts";
import { markPrepared } from "../db/applications.ts";

export interface PreparedJob {
  jobId: string;
  company: string;
  title: string;
  applyUrl: string;
  files: string[];
  /** Set when the draft asked for something the profile does not contain. */
  missing: string[];
}

export interface PrepareSummary {
  approved: number;
  prepared: PreparedJob[];
  /** Approved but never drafted — nothing to finalise yet. */
  undrafted: Array<{ jobId: string; company: string; title: string }>;
}

interface Row {
  id: string;
  company: string;
  title: string;
  apply_url: string;
  note: string | null;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

/**
 * Copy a job's drafts into the outbox, applying any review note.
 *
 * A note written during review is guidance for the final letter, so it is
 * carried across as a visible instruction rather than silently dropped.
 */
async function finalise(paths: Paths, job: Row): Promise<PreparedJob | null> {
  const draftDir = join(paths.drafts, job.id);
  let entries: string[];
  try {
    entries = await readdir(draftDir);
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  const outDir = join(paths.outbox, job.id);
  await mkdir(outDir, { recursive: true });

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    // cover_letter.md becomes cover_letter_final.md, so the finalised copy is
    // never confused with the draft it came from.
    const target = entry.replace(/\.md$/, entry.startsWith("MISSING") ? ".md" : "_final.md");
    await copyFile(join(draftDir, entry), join(outDir, target));
    files.push(target);
  }

  if (job.note) {
    await writeFile(
      join(outDir, "REVIEW_NOTE.md"),
      `You wrote this while reviewing:\n\n> ${job.note}\n`,
      "utf8",
    );
    files.push("REVIEW_NOTE.md");
  }

  const missingText = await readIfPresent(join(draftDir, "MISSING.md"));
  const missing = missingText
    ? missingText
        .split("\n")
        .filter((l) => l.startsWith("- "))
        .map((l) => l.slice(2))
    : [];

  return {
    jobId: job.id,
    company: job.company,
    title: job.title,
    applyUrl: job.apply_url,
    files,
    missing,
  };
}

export async function prepareApproved(db: Database, paths: Paths): Promise<PrepareSummary> {
  const jobs = db
    .query<Row, []>(
      `SELECT j.id, j.company, j.title, j.apply_url, a.note
       FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
       WHERE j.review_status = 'approved'
       ORDER BY j.company`,
    )
    .all();

  const summary: PrepareSummary = { approved: jobs.length, prepared: [], undrafted: [] };

  for (const job of jobs) {
    const result = await finalise(paths, job);
    if (!result) {
      summary.undrafted.push({ jobId: job.id, company: job.company, title: job.title });
      continue;
    }
    markPrepared(db, job.id);
    summary.prepared.push(result);
  }

  return summary;
}
