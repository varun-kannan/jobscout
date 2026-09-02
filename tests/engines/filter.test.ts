import { describe, expect, test } from "bun:test";
import { epochToIso, matchesTerms, withinAge } from "../../src/engines/boards/filter.ts";

const TERMS = ["backend engineer", "software engineer", "senior software engineer"];

describe("matchesTerms", () => {
  test("keeps everything when no terms are configured", () => {
    expect(matchesTerms([], { title: "Chief Llama Groomer" })).toBe(true);
  });

  test("matches on the role word", () => {
    expect(matchesTerms(TERMS, { title: "Backend Engineer" })).toBe(true);
    expect(matchesTerms(TERMS, { title: "Staff Software Engineer, Payments" })).toBe(true);
  });

  test("matches regardless of the seniority attached", () => {
    for (const title of [
      "Junior Backend Engineer",
      "Principal Software Engineer",
      "Software Engineer II",
    ]) {
      expect(matchesTerms(TERMS, { title })).toBe(true);
    }
  });

  /**
   * The bug this guard exists for. Searching "senior software engineer" once
   * let through a page of unrelated roles that shared only the word "senior":
   * Senior Corporate Communications Manager, Senior Product Designer, Senior
   * Customer Support Specialist. Seniority describes level, not field.
   */
  test("does not match on seniority alone", () => {
    for (const title of [
      "Senior Corporate Communications Manager",
      "Senior Product Designer",
      "Senior Customer Support Specialist",
      "Senior Creative Digital Strategist",
      "Lead Financial Accountant",
      "Principal Interior Designer",
    ]) {
      expect(matchesTerms(TERMS, { title })).toBe(false);
    }
  });

  test("still works when the whole term is a seniority word", () => {
    expect(matchesTerms(["senior"], { title: "Senior Product Designer" })).toBe(true);
  });

  test("matches through tags when the title is unhelpful", () => {
    expect(
      matchesTerms(TERMS, { title: "Join our team!", tags: ["Engineering", "Backend"] }),
    ).toBe(true);
  });

  test("rejects an unrelated role with unrelated tags", () => {
    expect(
      matchesTerms(TERMS, { title: "Warehouse Associate", tags: ["Logistics"] }),
    ).toBe(false);
  });

  test("is case- and punctuation-insensitive", () => {
    expect(matchesTerms(["backend engineer"], { title: "BACKEND-ENGINEER (m/w/d)" })).toBe(true);
  });

  test("keeps technology terms with symbols intact", () => {
    expect(matchesTerms(["c# developer"], { title: "C# Developer" })).toBe(true);
    expect(matchesTerms(["node.js engineer"], { title: "Node.js Engineer" })).toBe(true);
  });
});

describe("withinAge", () => {
  test("keeps a posting with no date rather than discarding it", () => {
    expect(withinAge(null, 30)).toBe(true);
    expect(withinAge("not a date", 30)).toBe(true);
  });

  test("keeps a recent posting", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect(withinAge(yesterday, 30)).toBe(true);
  });

  test("drops a posting past the window", () => {
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    expect(withinAge(old, 30)).toBe(false);
  });
});

describe("epochToIso", () => {
  test("treats small numbers as seconds", () => {
    expect(epochToIso(1_787_815_839)).toBe(new Date(1_787_815_839_000).toISOString());
  });

  test("treats large numbers as milliseconds", () => {
    expect(epochToIso(1_787_815_839_000)).toBe(new Date(1_787_815_839_000).toISOString());
  });

  test("returns null for nothing usable", () => {
    expect(epochToIso(null)).toBeNull();
    expect(epochToIso(0)).toBeNull();
    expect(epochToIso("nonsense")).toBeNull();
  });
});
