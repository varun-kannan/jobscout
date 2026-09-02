/**
 * Terminal output primitives.
 *
 * picocolors already disables itself when stdout is not a TTY or NO_COLOR is
 * set, so piping jobscout into a file produces clean text with no escape codes.
 */

import pc from "picocolors";

export const c = pc;

export const isTTY = Boolean(process.stdout.isTTY);

export const sym = {
  ok: "✓",
  fail: "✗",
  warn: "!",
  skip: "○",
  ask: "?",
  arrow: "→",
  bullet: "·",
} as const;

export function ok(msg: string): string {
  return `${c.green(sym.ok)} ${msg}`;
}

export function fail(msg: string): string {
  return `${c.red(sym.fail)} ${msg}`;
}

export function warn(msg: string): string {
  return `${c.yellow(sym.warn)} ${msg}`;
}

export function skip(msg: string): string {
  return `${c.dim(sym.skip)} ${c.dim(msg)}`;
}

export function heading(msg: string): string {
  return c.dim(msg.toUpperCase());
}

export function hint(msg: string): string {
  return c.dim(msg);
}

/** Pad to a fixed width for aligned two-column status output. */
export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Indent every line of a block by `n` spaces. */
export function indent(text: string, n = 4): string {
  const prefix = " ".repeat(n);
  return text
    .split("\n")
    .map((line) => (line.length ? prefix + line : line))
    .join("\n");
}

export function line(msg = ""): void {
  process.stdout.write(msg + "\n");
}
