/**
 * The review screen.
 *
 * This replaces the worst part of the system it descends from: hand-typing a
 * status into hundreds of spreadsheet rows. Every row shows its own count, so
 * you are reading evidence rather than trusting a rating.
 *
 * All logic lives in state.ts. These components render a value and translate
 * keystrokes into actions — nothing more.
 */

import React, { useReducer } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  currentJob,
  reduce,
  type Decision,
  type ReviewJob,
  type ReviewState,
} from "./state.ts";
import { labelsFor } from "../skills/match.ts";

/**
 * Column widths, sized to fit the list pane rather than the content.
 *
 * Ink wraps by default, so a row wider than its box silently becomes two rows
 * and the list turns into a mess. Every row is therefore explicitly truncated
 * and the columns are budgeted to the pane, not to the longest title.
 */
const BAR_WIDTH = 8;
const COMPANY_WIDTH = 13;
const TITLE_WIDTH = 20;

function bar(fraction: number): { filled: string; empty: string } {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * BAR_WIDTH);
  return { filled: "█".repeat(filled), empty: "░".repeat(BAR_WIDTH - filled) };
}

function pad(text: string, width: number): string {
  return text.length > width ? text.slice(0, width - 1) + "…" : text.padEnd(width);
}

function decisionMark(decision: Decision | undefined): React.ReactElement {
  if (decision === "approved") return <Text color="green">✓</Text>;
  if (decision === "rejected") return <Text color="red">✗</Text>;
  return <Text> </Text>;
}

/* ── list ─────────────────────────────────────────────────────────── */

function JobRow({
  job,
  selected,
  decision,
  hasNote,
}: {
  job: ReviewJob;
  selected: boolean;
  decision: Decision | undefined;
  hasNote: boolean;
}): React.ReactElement {
  const count = `${job.matchedRequired}/${job.totalRequired}`;
  const pct = `${Math.round(job.coverage * 100)}%`;
  const { filled, empty } = bar(job.coverage);

  return (
    <Text wrap="truncate">
      <Text color={selected ? "cyan" : undefined}>{selected ? "▸" : " "}</Text>
      {decisionMark(decision)}
      <Text bold={selected}>{pad(count, 6)}</Text>
      <Text color="green">{filled}</Text>
      <Text dimColor>{empty}</Text>
      <Text>{pct.padStart(5)} </Text>
      <Text color={selected ? "cyan" : undefined}>{pad(job.company, COMPANY_WIDTH)}</Text>
      <Text dimColor={!selected}>{pad(job.title, TITLE_WIDTH)}</Text>
      <Text color="yellow">{job.aiScore !== null ? `★${job.aiScore}` : "  "}</Text>
      <Text color="magenta">{hasNote ? "✎" : ""}</Text>
    </Text>
  );
}

function JobList({ state }: { state: ReviewState }): React.ReactElement {
  // A window around the cursor, so a thousand rows do not all render.
  const height = 16;
  const start = Math.max(0, Math.min(state.cursor - Math.floor(height / 2), state.visible.length - height));
  const window = state.visible.slice(Math.max(0, start), Math.max(0, start) + height);

  if (state.visible.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>
          {state.search ? `Nothing matches "${state.search}".` : "Nothing left to review."}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {window.map((index, row) => {
        const job = state.all[index]!;
        return (
          <JobRow
            key={job.id}
            job={job}
            selected={Math.max(0, start) + row === state.cursor}
            decision={state.decisions.get(job.id)}
            hasNote={state.notes.has(job.id)}
          />
        );
      })}
    </Box>
  );
}

/* ── detail ───────────────────────────────────────────────────────── */

function SkillsPane({ job }: { job: ReviewJob }): React.ReactElement {
  const required = bar(job.coverage);
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>REQUIRED  </Text>
        <Text color="green">{required.filled}</Text>
        <Text dimColor>{required.empty}</Text>
        <Text>
          {"  "}
          {job.matchedRequired}/{job.totalRequired} ({Math.round(job.coverage * 100)}%)
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {job.matched.length > 0 && (
          <Text>
            <Text color="green">✓ </Text>
            {labelsFor(job.matched).join(" · ")}
          </Text>
        )}
        {job.missing.length > 0 && (
          <Text>
            <Text color="red">✗ </Text>
            {labelsFor(job.missing).join(" · ")}
          </Text>
        )}
        {job.bonus.length > 0 && (
          <Text>
            <Text color="yellow">+ </Text>
            {labelsFor(job.bonus).join(" · ")}
            <Text dimColor> (not asked for)</Text>
          </Text>
        )}
      </Box>

      {job.reason && (
        <Box marginTop={1}>
          <Text>
            <Text color="yellow">★{job.aiScore} </Text>
            {job.reason}
          </Text>
        </Box>
      )}
      {job.concerns.length > 0 && (
        <Box flexDirection="column">
          {job.concerns.map((concern) => (
            <Text key={concern} color="yellow">
              ⚠ {concern}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function DetailPane({ state }: { state: ReviewState }): React.ReactElement {
  const job = currentJob(state);
  if (!job) return <Text dimColor>—</Text>;

  return (
    <Box flexDirection="column">
      <Text bold>{job.title}</Text>
      <Text>
        <Text color="cyan">{job.company}</Text>
        <Text dimColor>
          {"  "}
          {job.location || "—"} · {job.engine}
        </Text>
      </Text>
      <Text dimColor>
        {job.salary}
        {job.remoteRestriction ? ` · remote: ${job.remoteRestriction}` : ""}
      </Text>

      <Box marginTop={1}>
        {state.pane === "skills" ? (
          <SkillsPane job={job} />
        ) : state.pane === "description" ? (
          <Text>{job.description.slice(0, 1400) || "(no description)"}</Text>
        ) : (
          <Text dimColor>
            {job.hasDraft
              ? "Draft written. Open it in drafts/ — or press d to print the path."
              : "No draft yet. Run `jobscout draft` after approving."}
          </Text>
        )}
      </Box>
    </Box>
  );
}

/* ── chrome ───────────────────────────────────────────────────────── */

function Header({ state }: { state: ReviewState }): React.ReactElement {
  let approved = 0;
  let rejected = 0;
  for (const d of state.decisions.values()) d === "approved" ? approved++ : rejected++;

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text bold>jobscout review</Text>
      <Text dimColor>
        {state.visible.length} shown · sorted by {state.sort}
        {state.hideDecided ? " · hiding decided" : ""} ·{" "}
        <Text color="green">{approved} approved</Text> ·{" "}
        <Text color="red">{rejected} rejected</Text>
      </Text>
    </Box>
  );
}

function Footer({ state }: { state: ReviewState }): React.ReactElement {
  if (state.editing) {
    return (
      <Box paddingX={1}>
        <Text color="cyan">{state.editing.kind === "search" ? "/" : "note: "}</Text>
        <Text>{state.editing.buffer}</Text>
        <Text inverse> </Text>
        <Text dimColor>{"  enter to accept · esc to cancel"}</Text>
      </Box>
    );
  }
  return (
    <Box paddingX={1}>
      <Text dimColor>
        a approve · r reject · u undo · e note · Tab pane · s sort · h hide · / search · q save
      </Text>
    </Box>
  );
}

/* ── app ──────────────────────────────────────────────────────────── */

export function Review({
  initial,
  onDone,
}: {
  initial: ReviewState;
  onDone(state: ReviewState): void;
}): React.ReactElement {
  const [state, dispatch] = useReducer(reduce, initial);
  const { exit } = useApp();

  useInput((input, key) => {
    if (state.editing) {
      if (key.return) dispatch({ type: "commitEditing" });
      else if (key.escape) dispatch({ type: "cancelEditing" });
      else if (key.backspace || key.delete) dispatch({ type: "editKey", key: "backspace" });
      else if (input) dispatch({ type: "editKey", key: input });
      return;
    }

    if (key.downArrow || input === "j") dispatch({ type: "move", delta: 1 });
    else if (key.upArrow || input === "k") dispatch({ type: "move", delta: -1 });
    else if (key.pageDown) dispatch({ type: "move", delta: 10 });
    else if (key.pageUp) dispatch({ type: "move", delta: -10 });
    else if (input === "g") dispatch({ type: "jump", to: "top" });
    else if (input === "G") dispatch({ type: "jump", to: "bottom" });
    else if (input === "a") dispatch({ type: "decide", decision: "approved" });
    else if (input === "r") dispatch({ type: "decide", decision: "rejected" });
    else if (input === "u") dispatch({ type: "undecide" });
    else if (key.tab) dispatch({ type: "cyclePane", delta: 1 });
    else if (input === "s") dispatch({ type: "cycleSort" });
    else if (input === "h") dispatch({ type: "toggleHideDecided" });
    else if (input === "/") dispatch({ type: "startEditing", kind: "search" });
    else if (input === "e") dispatch({ type: "startEditing", kind: "note" });
    else if (input === "q") {
      onDone(state);
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Header state={state} />
      <Box>
        <Box flexDirection="column" width={62} flexShrink={0}>
          <JobList state={state} />
        </Box>
        <Box flexDirection="column" paddingLeft={2} flexGrow={1}>
          <DetailPane state={state} />
        </Box>
      </Box>
      <Footer state={state} />
    </Box>
  );
}
