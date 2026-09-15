import { describe, expect, test } from "bun:test";
import { normalisePostedAt } from "../../src/db/jobs.ts";

describe("normalisePostedAt", () => {
  /** Recruitee's format, which SQLite's date functions reject. */
  test("converts a trailing-UTC timestamp to ISO", () => {
    expect(normalisePostedAt("2023-10-06 13:36:06 UTC")).toBe("2023-10-06T13:36:06.000Z");
  });

  test("applies an offset rather than dropping it", () => {
    expect(normalisePostedAt("2026-08-31T12:14:49-04:00")).toBe("2026-08-31T16:14:49.000Z");
  });

  test("leaves an ISO timestamp as it was", () => {
    expect(normalisePostedAt("2026-09-10T10:30:38.000Z")).toBe("2026-09-10T10:30:38.000Z");
  });

  test("returns null for nothing, or for a string that is not a date", () => {
    expect(normalisePostedAt(null)).toBeNull();
    expect(normalisePostedAt(undefined)).toBeNull();
    expect(normalisePostedAt("")).toBeNull();
    expect(normalisePostedAt("last week")).toBeNull();
  });
});
