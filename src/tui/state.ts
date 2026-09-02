/**
 * Review-screen state, as a pure reducer.
 *
 * Every decision the interface makes — what is selected, what is visible, what
 * you have approved — happens here, with no React and no terminal involved.
 * Same reasoning as the matcher: the consequential logic is testable in
 * isolation, and the components become a thin rendering of a value.
 *
 * Decisions are held in memory until you leave, so a mis-keyed `r` can be
 * undone. Nothing reaches the database until the session is committed.
 */

import type { RankedJob } from "../skills/rank.ts";

export type Decision = "approved" | "rejected";
export type SortKey = "match" | "coverage" | "score" | "company";
export type Pane = "skills" | "description" | "draft";

export interface ReviewJob extends RankedJob {
  aiScore: number | null;
  reason: string | null;
  concerns: string[];
  description: string;
  salary: string;
  remote: number | null;
  remoteRestriction: string | null;
  hasDraft: boolean;
}

export interface ReviewState {
  readonly all: readonly ReviewJob[];
  /** Indices into `all`, after filtering and sorting. */
  readonly visible: readonly number[];
  /** Position within `visible`, not within `all`. */
  readonly cursor: number;
  readonly decisions: ReadonlyMap<string, Decision>;
  readonly notes: ReadonlyMap<string, string>;
  readonly sort: SortKey;
  readonly search: string;
  readonly hideDecided: boolean;
  readonly pane: Pane;
  /** Set while typing into the search field or a note. */
  readonly editing: null | { kind: "search" | "note"; buffer: string };
  readonly done: boolean;
}

export type Action =
  | { type: "move"; delta: number }
  | { type: "jump"; to: "top" | "bottom" }
  | { type: "decide"; decision: Decision }
  | { type: "undecide" }
  | { type: "cyclePane"; delta: number }
  | { type: "cycleSort" }
  | { type: "toggleHideDecided" }
  | { type: "startEditing"; kind: "search" | "note" }
  | { type: "editKey"; key: string }
  | { type: "commitEditing" }
  | { type: "cancelEditing" }
  | { type: "quit" };

const SORTS: readonly SortKey[] = ["match", "coverage", "score", "company"];
const PANES: readonly Pane[] = ["skills", "description", "draft"];

function compare(a: ReviewJob, b: ReviewJob, sort: SortKey): number {
  switch (sort) {
    case "coverage":
      return b.coverage - a.coverage || b.matchScore - a.matchScore;
    case "score":
      // Unscored jobs sort below scored ones rather than above them.
      return (b.aiScore ?? -1) - (a.aiScore ?? -1) || b.matchScore - a.matchScore;
    case "company":
      return a.company.localeCompare(b.company) || b.matchScore - a.matchScore;
    default:
      return b.matchScore - a.matchScore || b.coverage - a.coverage;
  }
}

function matchesSearch(job: ReviewJob, needle: string): boolean {
  if (!needle) return true;
  const q = needle.toLowerCase();
  return (
    job.company.toLowerCase().includes(q) ||
    job.title.toLowerCase().includes(q) ||
    job.location.toLowerCase().includes(q)
  );
}

/**
 * Recompute what is on screen.
 *
 * The cursor follows the *job*, not the row number: after approving something
 * with `hideDecided` on, the list shifts underneath and a naive index would
 * silently move the selection to a different job than the one just acted on.
 */
function refocus(state: ReviewState, keepJobId?: string): ReviewState {
  const visible = state.all
    .map((_, i) => i)
    .filter((i) => {
      const job = state.all[i]!;
      if (!matchesSearch(job, state.search)) return false;
      if (state.hideDecided && state.decisions.has(job.id)) return false;
      return true;
    })
    .sort((a, b) => compare(state.all[a]!, state.all[b]!, state.sort));

  let cursor = state.cursor;
  if (keepJobId) {
    const found = visible.findIndex((i) => state.all[i]!.id === keepJobId);
    // When the focused job has just been filtered away, stay where it was so
    // the next undecided job comes under the cursor.
    cursor = found >= 0 ? found : Math.min(state.cursor, Math.max(0, visible.length - 1));
  }
  return { ...state, visible, cursor: clampCursor(cursor, visible.length) };
}

function clampCursor(cursor: number, length: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(cursor, length - 1));
}

export function initialState(jobs: readonly ReviewJob[]): ReviewState {
  return refocus({
    all: jobs,
    visible: [],
    cursor: 0,
    decisions: new Map(),
    notes: new Map(),
    sort: "match",
    search: "",
    hideDecided: false,
    pane: "skills",
    editing: null,
    done: false,
  });
}

export function currentJob(state: ReviewState): ReviewJob | undefined {
  const index = state.visible[state.cursor];
  return index === undefined ? undefined : state.all[index];
}

export function reduce(state: ReviewState, action: Action): ReviewState {
  // While typing, ordinary keys are text rather than commands.
  if (state.editing && action.type === "editKey") {
    const { kind, buffer } = state.editing;
    const next =
      action.key === "backspace" ? buffer.slice(0, -1) : buffer + action.key;
    const editing = { kind, buffer: next };
    // Search filters as you type; a note does not.
    return kind === "search"
      ? refocus({ ...state, editing, search: next }, currentJob(state)?.id)
      : { ...state, editing };
  }

  switch (action.type) {
    case "move": {
      if (state.visible.length === 0) return state;
      return { ...state, cursor: clampCursor(state.cursor + action.delta, state.visible.length) };
    }

    case "jump":
      return {
        ...state,
        cursor: action.to === "top" ? 0 : Math.max(0, state.visible.length - 1),
      };

    case "decide": {
      const job = currentJob(state);
      if (!job) return state;
      const decisions = new Map(state.decisions);
      decisions.set(job.id, action.decision);
      const moved = { ...state, decisions };
      // With decided rows hidden the list shrinks; otherwise advance so a run
      // of decisions does not need a separate keystroke each time.
      return state.hideDecided
        ? refocus(moved, job.id)
        : { ...moved, cursor: clampCursor(state.cursor + 1, state.visible.length) };
    }

    case "undecide": {
      const job = currentJob(state);
      if (!job) return state;
      const decisions = new Map(state.decisions);
      decisions.delete(job.id);
      return refocus({ ...state, decisions }, job.id);
    }

    case "cyclePane": {
      const index = PANES.indexOf(state.pane);
      const next = (index + action.delta + PANES.length) % PANES.length;
      return { ...state, pane: PANES[next]! };
    }

    case "cycleSort": {
      const index = SORTS.indexOf(state.sort);
      const sort = SORTS[(index + 1) % SORTS.length]!;
      return refocus({ ...state, sort }, currentJob(state)?.id);
    }

    case "toggleHideDecided":
      return refocus({ ...state, hideDecided: !state.hideDecided }, currentJob(state)?.id);

    case "startEditing":
      return {
        ...state,
        editing: {
          kind: action.kind,
          buffer:
            action.kind === "search"
              ? state.search
              : (currentJob(state) && state.notes.get(currentJob(state)!.id)) || "",
        },
      };

    case "commitEditing": {
      if (!state.editing) return state;
      if (state.editing.kind === "search") return { ...state, editing: null };
      const job = currentJob(state);
      if (!job) return { ...state, editing: null };
      const notes = new Map(state.notes);
      const text = state.editing.buffer.trim();
      if (text) notes.set(job.id, text);
      else notes.delete(job.id);
      return { ...state, notes, editing: null };
    }

    case "cancelEditing": {
      if (!state.editing) return state;
      // Abandoning a search restores the list it was filtering.
      return state.editing.kind === "search"
        ? refocus({ ...state, editing: null, search: "" }, currentJob(state)?.id)
        : { ...state, editing: null };
    }

    case "quit":
      return { ...state, done: true };

    default:
      return state;
  }
}

export interface SessionSummary {
  approved: string[];
  rejected: string[];
  notes: Array<{ jobId: string; note: string }>;
}

/** What the session decided, ready to persist. */
export function summarise(state: ReviewState): SessionSummary {
  const approved: string[] = [];
  const rejected: string[] = [];
  for (const [jobId, decision] of state.decisions) {
    (decision === "approved" ? approved : rejected).push(jobId);
  }
  return {
    approved,
    rejected,
    notes: [...state.notes.entries()].map(([jobId, note]) => ({ jobId, note })),
  };
}
