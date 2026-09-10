import { describe, expect, test } from "bun:test";
import { planEditor, describePlan } from "../../src/setup/editor.ts";

const FILE = "/tmp/work-history.md";

describe("planEditor", () => {
  /** $VISUAL is the full-screen editor by long convention; $EDITOR may not be. */
  test("prefers VISUAL over EDITOR", () => {
    const plan = planEditor(FILE, { VISUAL: "nvim", EDITOR: "vi" });
    expect(plan?.command).toEqual(["nvim", FILE]);
    expect(plan?.source).toBe("VISUAL");
  });

  test("uses EDITOR when VISUAL is unset", () => {
    expect(planEditor(FILE, { EDITOR: "nano" })?.command).toEqual(["nano", FILE]);
  });

  /** `code --wait` and `subl -n` are ordinary values for these variables. */
  test("keeps the flags an editor variable carries", () => {
    const plan = planEditor(FILE, { EDITOR: "code --wait" });
    expect(plan?.command).toEqual(["code", "--wait", FILE]);
  });

  test("ignores a variable that is only whitespace", () => {
    const plan = planEditor(FILE, { EDITOR: "   " }, "darwin");
    expect(plan?.source).toBe("platform");
  });

  /**
   * A terminal editor renders into the real terminal and must be waited for;
   * piping its output makes it appear to hang with a blank screen.
   */
  test("knows which editors take over the terminal", () => {
    expect(planEditor(FILE, { EDITOR: "vim" })?.blocking).toBe(true);
    expect(planEditor(FILE, { EDITOR: "nano" })?.blocking).toBe(true);
    expect(planEditor(FILE, { EDITOR: "code --wait" })?.blocking).toBe(false);
  });

  test("recognises a terminal editor given by full path", () => {
    expect(planEditor(FILE, { EDITOR: "/usr/bin/vim" })?.blocking).toBe(true);
  });

  /**
   * The case that produced the bug: nothing configured, which is the default
   * on macOS. It must still open rather than print a literal "$EDITOR".
   */
  test("falls back to the desktop when nothing is configured", () => {
    expect(planEditor(FILE, {}, "darwin")?.command).toEqual(["open", "-t", FILE]);
    expect(planEditor(FILE, {}, "linux")?.command).toEqual(["xdg-open", FILE]);
  });

  test("returns null where there is no way to open anything", () => {
    expect(planEditor(FILE, {}, "aix")).toBeNull();
  });
});

describe("describePlan", () => {
  test("names the variable it honoured", () => {
    const plan = planEditor(FILE, { EDITOR: "nano" });
    expect(describePlan(plan, FILE)).toContain("$EDITOR");
    expect(describePlan(plan, FILE)).toContain("nano");
  });

  test("does not claim a variable it did not use", () => {
    const plan = planEditor(FILE, {}, "darwin");
    expect(describePlan(plan, FILE)).not.toContain("$");
  });

  /** With nowhere to open, the user still needs to know what to do. */
  test("tells the user what to do when it cannot open anything", () => {
    const text = describePlan(null, FILE);
    expect(text).toContain(FILE);
    expect(text).toContain("jobscout init");
  });
});
