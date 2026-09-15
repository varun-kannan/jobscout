import { describe, expect, test } from "bun:test";
import { looksLikeTemplate, profileTextForDrafting } from "../../src/setup/checks/resume.ts";

const COVER_STYLE_TEMPLATE = `<!--
How your cover letters should sound. Tone, structure, things to avoid.
-->

Keep it to three short paragraphs. Open with the specific thing about the role
that matches my background \u2014 no "I am writing to apply for". Close without
"I look forward to hearing from you".
`;

describe("looksLikeTemplate", () => {
  test("flags an empty or near-empty file", () => {
    expect(looksLikeTemplate("")).toBe(true);
    expect(looksLikeTemplate("   \n\n  ")).toBe(true);
    expect(looksLikeTemplate("# Notes")).toBe(true);
  });

  test("flags obvious placeholder text", () => {
    const text = `## Company \u2014 Role (YYYY\u2013YYYY)\n- Bullet 1\n- Bullet 2\n- Bullet 3\n`;
    expect(looksLikeTemplate(text)).toBe(true);
  });

  test("flags a letter still signed 'Your Name'", () => {
    const text = `Dear Hiring Team,\n\nI would be a great fit for this role because of my extensive background.\n\nBest regards,\nYour Name\n`;
    expect(looksLikeTemplate(text)).toBe(true);
  });

  /**
   * The regression this check was written for: a template with no placeholder
   * phrases at all. Marker matching passes it; comparing against the shipped
   * template is what catches it.
   */
  test("flags an unedited template that contains no marker phrases", () => {
    expect(looksLikeTemplate(COVER_STYLE_TEMPLATE)).toBe(false);
    expect(looksLikeTemplate(COVER_STYLE_TEMPLATE, COVER_STYLE_TEMPLATE)).toBe(true);
  });

  test("is not fooled by reformatting the template", () => {
    const reflowed = COVER_STYLE_TEMPLATE.replace(/\n/g, "\n\n").replace(/ {2,}/g, " ");
    expect(looksLikeTemplate(reflowed, COVER_STYLE_TEMPLATE)).toBe(true);
  });

  test("ignores guidance comments when judging length", () => {
    const onlyComment = `<!-- ${"a lot of guidance text ".repeat(20)} -->\n`;
    expect(looksLikeTemplate(onlyComment)).toBe(true);
  });

  test("accepts genuinely written content", () => {
    const text = `## Fiserv \u2014 Senior Engineer (2021\u20132025)
- Built the online transaction integration with Fiserv covering authorization,
  capture, and settlement across three card networks.
- Cut p99 ledger write latency from 840ms to 120ms by batching writes.
- Led the PCI-DSS scope reduction that removed 4 services from the audit boundary.
`;
    expect(looksLikeTemplate(text)).toBe(false);
  });

  test("accepts an edited cover-letter style file", () => {
    const edited = COVER_STYLE_TEMPLATE + "\nAlways mention payments experience first.\n";
    expect(looksLikeTemplate(edited, COVER_STYLE_TEMPLATE)).toBe(false);
  });
});

describe("profileTextForDrafting", () => {
  /** Drafting used to send placeholder bullets to the model as real experience. */
  test("drops an unedited work history", () => {
    const starter = `## Company - Role (YYYY-YYYY)\n- Bullet 1\n- Bullet 2\n- Bullet 3\n`;
    expect(profileTextForDrafting(starter, "workHistory")).toBe("");
  });

  /** Existing installs still hold the old starter, which carried a ready-made style. */
  test("drops the cover-letter style earlier versions shipped", () => {
    const old = `<!--\nHow your cover letters should sound. Tone, structure, things to avoid.\nWritten in your voice, not a template with slots.\n-->\n\nKeep it to three short paragraphs. Open with the specific thing about the role\nthat matches my background \u2014 no "I am writing to apply for". Close without\n"I look forward to hearing from you".\n`;
    expect(profileTextForDrafting(old, "coverStyle")).toBe("");
  });

  test("drops the current empty-prompt starter", () => {
    const starter = `<!--\nguidance\n-->\n\nLength:\nTone:\nAlways:\nNever:\n`;
    expect(profileTextForDrafting(starter, "coverStyle")).toBe("");
  });

  test("keeps text the user actually wrote", () => {
    const mine = "Lead with payments work. Keep it under 200 words, plain and direct.";
    expect(profileTextForDrafting(mine, "coverStyle")).toBe(mine);
  });
});
