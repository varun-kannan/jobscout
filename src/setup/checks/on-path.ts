/**
 * Can you actually type `jobscout`?
 *
 * Building produces `dist/jobscout` and stops there, so every instruction in
 * the README — `jobscout init`, `jobscout discover` — fails with
 * `command not found` on a fresh clone. The build step looked like the install
 * step and was not one.
 *
 * This only applies when running from a source checkout: if you got here by
 * typing `jobscout`, the question is already answered.
 */

import { access, constants, symlink, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { caution, pass, type Check, type CheckResult } from "./check.ts";
import { commandExists, runCli } from "../../ai/providers/provider.ts";

/**
 * The checkout this file was loaded from, or null in a compiled binary.
 *
 * Bun serves a compiled binary's own modules from a virtual `/$bunfs` root, so
 * a path outside it means the source tree is real and on disk.
 */
export function sourceRoot(): string | null {
  const dir = import.meta.dir;
  if (dir.includes("$bunfs") || dir.includes("B:\\~BUN")) return null;
  // src/setup/checks → the repository root.
  const root = resolve(dir, "..", "..", "..");
  return existsSync(join(root, "package.json")) ? root : null;
}

/** The first directory on PATH we can write to, preferring the usual homes. */
export async function installTarget(
  pathValue = process.env.PATH ?? "",
): Promise<string | null> {
  const entries = pathValue.split(":").filter(Boolean);
  const preferred = ["/opt/homebrew/bin", "/usr/local/bin"];
  const home = process.env.HOME ?? "";
  const ordered = [
    ...preferred.filter((d) => entries.includes(d)),
    ...(home ? [join(home, ".local", "bin")].filter((d) => entries.includes(d)) : []),
    ...entries.filter((d) => !preferred.includes(d)),
  ];

  for (const dir of ordered) {
    // Skip the system directories that need a password; the point is a fix
    // that runs without one.
    if (dir.startsWith("/usr/bin") || dir.startsWith("/bin") || dir.startsWith("/sbin")) continue;
    try {
      await access(dir, constants.W_OK);
      return dir;
    } catch {
      // Not writable — keep looking.
    }
  }
  return null;
}

export const onPathCheck: Check = {
  id: "on-path",
  title: "jobscout on PATH",
  phase: "environment",

  // Nothing to answer when the command being run *is* the installed one.
  applies: () => sourceRoot() !== null,

  async run(): Promise<CheckResult> {
    if (await commandExists("jobscout")) return pass("installed");

    const root = sourceRoot();
    const target = await installTarget();

    if (!root || !target) {
      return caution("not installed — use `bun run src/index.ts <command>`", {
        detail: [
          "No writable directory on PATH, so this cannot be done for you.",
          root ? `Link it by hand:  ln -s ${join(root, "dist", "jobscout")} <dir-on-your-PATH>` : "",
        ].filter(Boolean),
      });
    }

    const binary = join(root, "dist", "jobscout");
    const link = join(target, "jobscout");

    return caution("not installed — `jobscout` is not a command yet", {
      detail: [
        "Building writes dist/jobscout; it does not put it on your PATH.",
        `Would link ${link} → ${binary}`,
      ],
      fix: {
        label: `Install jobscout into ${target}?`,
        defaultYes: true,
        async run() {
          // Build first when there is nothing to link to, so a fresh clone
          // gets a working command from this one answer.
          if (!existsSync(binary)) {
            await runCli(["bun", "build", "src/index.ts", "--compile", "--outfile", "dist/jobscout"], {
              cwd: root,
            });
          }
          // A symlink rather than a copy: rebuilding then updates the command
          // in place, instead of leaving a stale binary that looks current.
          await unlink(link).catch(() => {});
          await symlink(binary, link);
        },
      },
    });
  },
};
