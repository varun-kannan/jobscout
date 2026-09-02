import { describe, expect, test } from "bun:test";
import {
  currentJob,
  initialState,
  reduce,
  summarise,
  type Action,
  type ReviewJob,
  type ReviewState,
} from "../../src/tui/state.ts";

function job(over: Partial<ReviewJob> & { id: string }): ReviewJob {
  return {
    company: "Acme",
    title: "Backend Engineer",
    location: "Remote",
    engine: "greenhouse",
    description: "We need Go.",
    matchedRequired: 5,
    totalRequired: 10,
    coverage: 0.5,
    matchScore: 0.5,
    matched: ["go"],
    missing: ["kafka"],
    bonus: [],
    aiScore: null,
    reason: null,
    concerns: [],
    salary: "not stated",
    remote: 1,
    remoteRestriction: null,
    hasDraft: false,
    ...over,
  };
}

const JOBS: ReviewJob[] = [
  job({ id: "a", company: "Affirm", matchScore: 0.9, coverage: 0.82, aiScore: 4 }),
  job({ id: "b", company: "Razorpay", matchScore: 0.8, coverage: 0.8, aiScore: 5 }),
  job({ id: "c", company: "Groww", matchScore: 0.7, coverage: 0.78, aiScore: null }),
  job({ id: "d", company: "Beta", matchScore: 0.6, coverage: 0.9, aiScore: 2 }),
];

function run(state: ReviewState, ...actions: Action[]): ReviewState {
  return actions.reduce(reduce, state);
}

const start = () => initialState(JOBS);

describe("initial state", () => {
  test("shows everything, best match first", () => {
    const s = start();
    expect(s.visible).toHaveLength(4);
    expect(currentJob(s)!.id).toBe("a");
  });

  test("starts with nothing decided", () => {
    expect(summarise(start())).toEqual({ approved: [], rejected: [], notes: [] });
  });
});

describe("navigation", () => {
  test("moves down and up", () => {
    let s = run(start(), { type: "move", delta: 1 });
    expect(currentJob(s)!.id).toBe("b");
    s = run(s, { type: "move", delta: -1 });
    expect(currentJob(s)!.id).toBe("a");
  });

  test("stops at the ends rather than wrapping", () => {
    // Wrapping in a triage list makes it easy to review something twice
    // without noticing.
    expect(currentJob(run(start(), { type: "move", delta: -5 }))!.id).toBe("a");
    expect(currentJob(run(start(), { type: "move", delta: 99 }))!.id).toBe("d");
  });

  test("jumps to top and bottom", () => {
    const s = run(start(), { type: "jump", to: "bottom" });
    expect(currentJob(s)!.id).toBe("d");
    expect(currentJob(run(s, { type: "jump", to: "top" }))!.id).toBe("a");
  });
});

describe("deciding", () => {
  test("records an approval and advances", () => {
    const s = run(start(), { type: "decide", decision: "approved" });
    expect(s.decisions.get("a")).toBe("approved");
    // Advancing means a run of decisions needs no extra keystroke.
    expect(currentJob(s)!.id).toBe("b");
  });

  test("records a rejection", () => {
    const s = run(start(), { type: "decide", decision: "rejected" });
    expect(summarise(s).rejected).toEqual(["a"]);
  });

  /** A mis-keyed decision must be undoable while still on screen. */
  test("undoes a decision", () => {
    let s = run(start(), { type: "decide", decision: "rejected" });
    s = run(s, { type: "move", delta: -1 }, { type: "undecide" });
    expect(s.decisions.has("a")).toBe(false);
    expect(summarise(s).rejected).toEqual([]);
  });

  test("changing a decision replaces rather than duplicates it", () => {
    let s = run(start(), { type: "decide", decision: "rejected" });
    s = run(s, { type: "move", delta: -1 }, { type: "decide", decision: "approved" });
    expect(summarise(s).approved).toEqual(["a"]);
    expect(summarise(s).rejected).toEqual([]);
  });

  test("does nothing when the list is empty", () => {
    const empty = initialState([]);
    expect(() => run(empty, { type: "decide", decision: "approved" })).not.toThrow();
    expect(summarise(run(empty, { type: "decide", decision: "approved" })).approved).toEqual([]);
  });
});

describe("hiding decided rows", () => {
  /**
   * The subtle one. With decided rows hidden, the list shifts underneath after
   * every decision — a cursor tracking the row *number* would silently land on
   * a different job than the one just acted on.
   */
  test("keeps the cursor on a sensible job as rows disappear", () => {
    let s = run(start(), { type: "toggleHideDecided" });
    expect(s.visible).toHaveLength(4);

    s = run(s, { type: "decide", decision: "approved" }); // decides "a"
    expect(s.visible).toHaveLength(3);
    // "a" is gone, so the next undecided job is under the cursor.
    expect(currentJob(s)!.id).toBe("b");

    s = run(s, { type: "decide", decision: "rejected" }); // decides "b"
    expect(s.visible).toHaveLength(2);
    expect(currentJob(s)!.id).toBe("c");
  });

  test("brings decided rows back when toggled off", () => {
    let s = run(start(), { type: "toggleHideDecided" }, { type: "decide", decision: "approved" });
    expect(s.visible).toHaveLength(3);
    s = run(s, { type: "toggleHideDecided" });
    expect(s.visible).toHaveLength(4);
  });

  test("survives deciding the last remaining job", () => {
    let s = run(initialState([JOBS[0]!]), { type: "toggleHideDecided" });
    s = run(s, { type: "decide", decision: "approved" });
    expect(s.visible).toHaveLength(0);
    expect(currentJob(s)).toBeUndefined();
    expect(summarise(s).approved).toEqual(["a"]);
  });
});

describe("sorting", () => {
  /** Assert the ordering, not the cursor — the cursor deliberately stays put. */
  const order = (s: ReviewState) => s.visible.map((i) => s.all[i]!.id);

  test("cycles through the sort keys and reorders the list", () => {
    let s = start();
    expect(s.sort).toBe("match");
    expect(order(s)[0]).toBe("a");

    s = run(s, { type: "cycleSort" });
    expect(s.sort).toBe("coverage");
    expect(order(s)[0]).toBe("d"); // highest coverage
  });

  test("sorts by AI score, putting unscored jobs last", () => {
    const s = run(start(), { type: "cycleSort" }, { type: "cycleSort" });
    expect(s.sort).toBe("score");
    expect(order(s)[0]).toBe("b"); // ★5
    // "c" has no score and must not float above a scored job.
    expect(order(s).indexOf("c")).toBe(order(s).length - 1);
  });

  test("keeps the focused job under the cursor when re-sorting", () => {
    let s = run(start(), { type: "move", delta: 3 }); // "d"
    expect(currentJob(s)!.id).toBe("d");
    s = run(s, { type: "cycleSort" });
    // Order changed, but the same job stays selected.
    expect(currentJob(s)!.id).toBe("d");
  });

  test("returns to match after a full cycle", () => {
    let s = start();
    for (let i = 0; i < 4; i++) s = run(s, { type: "cycleSort" });
    expect(s.sort).toBe("match");
  });
});

describe("search", () => {
  test("filters as you type", () => {
    let s = run(start(), { type: "startEditing", kind: "search" });
    for (const ch of "razor") s = run(s, { type: "editKey", key: ch });
    expect(s.visible).toHaveLength(1);
    expect(currentJob(s)!.id).toBe("b");
  });

  test("is case-insensitive and matches title and location too", () => {
    let s = run(start(), { type: "startEditing", kind: "search" });
    for (const ch of "BACKEND") s = run(s, { type: "editKey", key: ch });
    expect(s.visible).toHaveLength(4);
  });

  test("backspace widens the filter again", () => {
    let s = run(start(), { type: "startEditing", kind: "search" });
    for (const ch of "razor") s = run(s, { type: "editKey", key: ch });
    for (let i = 0; i < 5; i++) s = run(s, { type: "editKey", key: "backspace" });
    expect(s.visible).toHaveLength(4);
  });

  test("cancelling restores the full list", () => {
    let s = run(start(), { type: "startEditing", kind: "search" });
    for (const ch of "razor") s = run(s, { type: "editKey", key: ch });
    s = run(s, { type: "cancelEditing" });
    expect(s.search).toBe("");
    expect(s.visible).toHaveLength(4);
  });

  test("committing keeps the filter", () => {
    let s = run(start(), { type: "startEditing", kind: "search" });
    for (const ch of "groww") s = run(s, { type: "editKey", key: ch });
    s = run(s, { type: "commitEditing" });
    expect(s.editing).toBeNull();
    expect(s.visible).toHaveLength(1);
  });

  /** Keys must be text while typing, not commands. */
  test("typing a command letter into search does not decide anything", () => {
    let s = run(start(), { type: "startEditing", kind: "search" });
    for (const ch of "ar") s = run(s, { type: "editKey", key: ch });
    expect(s.decisions.size).toBe(0);
    expect(s.editing?.buffer).toBe("ar");
  });
});

describe("notes", () => {
  test("attaches a note to the focused job", () => {
    let s = run(start(), { type: "startEditing", kind: "note" });
    for (const ch of "ask about on-call") s = run(s, { type: "editKey", key: ch });
    s = run(s, { type: "commitEditing" });
    expect(s.notes.get("a")).toBe("ask about on-call");
  });

  test("editing a note reopens with its current text", () => {
    let s = run(start(), { type: "startEditing", kind: "note" });
    for (const ch of "hello") s = run(s, { type: "editKey", key: ch });
    s = run(s, { type: "commitEditing" }, { type: "startEditing", kind: "note" });
    expect(s.editing?.buffer).toBe("hello");
  });

  test("an emptied note is removed", () => {
    let s = run(start(), { type: "startEditing", kind: "note" });
    for (const ch of "x") s = run(s, { type: "editKey", key: ch });
    s = run(s, { type: "commitEditing" }, { type: "startEditing", kind: "note" });
    s = run(s, { type: "editKey", key: "backspace" }, { type: "commitEditing" });
    expect(s.notes.has("a")).toBe(false);
  });

  test("a note does not filter the list the way search does", () => {
    let s = run(start(), { type: "startEditing", kind: "note" });
    for (const ch of "razor") s = run(s, { type: "editKey", key: ch });
    expect(s.visible).toHaveLength(4);
  });
});

describe("panes", () => {
  test("cycles and wraps", () => {
    let s = start();
    expect(s.pane).toBe("skills");
    s = run(s, { type: "cyclePane", delta: 1 });
    expect(s.pane).toBe("description");
    s = run(s, { type: "cyclePane", delta: 1 });
    expect(s.pane).toBe("draft");
    s = run(s, { type: "cyclePane", delta: 1 });
    expect(s.pane).toBe("skills");
  });
});

describe("summarise", () => {
  test("separates approvals from rejections", () => {
    let s = start();
    s = run(s, { type: "decide", decision: "approved" }); // a
    s = run(s, { type: "decide", decision: "rejected" }); // b
    s = run(s, { type: "decide", decision: "approved" }); // c
    const out = summarise(s);
    expect(out.approved.sort()).toEqual(["a", "c"]);
    expect(out.rejected).toEqual(["b"]);
  });

  test("reports notes alongside decisions", () => {
    let s = run(start(), { type: "startEditing", kind: "note" });
    for (const ch of "note") s = run(s, { type: "editKey", key: ch });
    s = run(s, { type: "commitEditing" }, { type: "decide", decision: "approved" });
    expect(summarise(s).notes).toEqual([{ jobId: "a", note: "note" }]);
  });
});
