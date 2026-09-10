/**
 * Opening a file the way the user expects "open it now" to mean.
 *
 * The old instruction printed a literal `$EDITOR /path/to/file`. On a machine
 * where `$EDITOR` is unset — which is the default on macOS — that line does
 * nothing useful when pasted, and the prompt that offered it had already
 * promised to open the file rather than describe how.
 */

export interface EditorPlan {
  /** The command to run, already resolved. */
  command: string[];
  /** True when the editor takes over the terminal and must be waited for. */
  blocking: boolean;
  /** Where it came from, for the line shown to the user. */
  source: "EDITOR" | "VISUAL" | "platform";
}

/** Terminal editors hold the terminal; a launcher returns immediately. */
const TERMINAL_EDITORS = ["vi", "vim", "nvim", "nano", "emacs", "helix", "hx", "micro", "pico"];

/**
 * Decide how to open a file, or null when there is no way to.
 *
 * `$VISUAL` wins over `$EDITOR` by long convention: `$EDITOR` may be a line
 * editor meant for dumb terminals, and `$VISUAL` is the full-screen one.
 */
export function planEditor(
  file: string,
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): EditorPlan | null {
  const configured = env.VISUAL?.trim() || env.EDITOR?.trim();
  if (configured) {
    // An editor variable may carry flags — `code --wait`, `subl -n`.
    const parts = configured.split(/\s+/).filter(Boolean);
    const binary = (parts[0] ?? "").split("/").pop() ?? "";
    return {
      command: [...parts, file],
      blocking: TERMINAL_EDITORS.includes(binary),
      source: env.VISUAL?.trim() ? "VISUAL" : "EDITOR",
    };
  }

  // Nothing configured: hand it to the desktop, which knows what .md opens in.
  if (platform === "darwin") {
    return { command: ["open", "-t", file], blocking: false, source: "platform" };
  }
  if (platform === "linux") {
    return { command: ["xdg-open", file], blocking: false, source: "platform" };
  }
  if (platform === "win32") {
    return { command: ["cmd", "/c", "start", "", file], blocking: false, source: "platform" };
  }
  return null;
}

/** A line telling the user what was run, or how to do it themselves. */
export function describePlan(plan: EditorPlan | null, file: string): string {
  if (!plan) return `Open ${file} in your editor, then re-run \`jobscout init\`.`;
  return plan.source === "platform"
    ? `Opened ${file}.`
    : `Opened with $${plan.source}: ${plan.command.slice(0, -1).join(" ")}`;
}

/**
 * Open the file. Resolves once a terminal editor exits, or as soon as a
 * desktop launcher has been handed the file.
 */
export async function openInEditor(
  file: string,
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): Promise<EditorPlan | null> {
  const plan = planEditor(file, env, platform);
  if (!plan) return null;

  const proc = Bun.spawn(plan.command, {
    // A terminal editor needs the real terminal, not a pipe, or it renders
    // into nothing and appears to hang.
    stdin: plan.blocking ? "inherit" : "ignore",
    stdout: plan.blocking ? "inherit" : "ignore",
    stderr: "ignore",
  });
  if (plan.blocking) await proc.exited;
  return plan;
}
