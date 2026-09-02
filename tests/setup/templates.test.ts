import { describe, expect, test } from "bun:test";
import { looksLikeTemplate } from "../../src/setup/checks/resume.ts";

const COVER_STYLE_TEMPLATE = `<!--
How your cover letters should sound. Tone, structure, things to avoid.
-->

Keep it to three short paragraphs. Open with the specific thing about the role
that matches my background — no "I am writing to apply for". Close without
"I look forward to hearing from you".
`;

describe("looksLikeTemplate", () => {
  test("flags an empty or near-empty file", () => {
    expect(looksLikeTemplate("")).toBe(true);
    expect(looksLikeTemplate("   \n\n  ")).toBe(true);
    expect(looksLikeTemplate("# Notes")).toBe(true);
  });

  test("flags obvious placeholder text", () => {
    const text = `## Company — Role (YYYY–YYYY)\n- Bullet 1\n- Bullet 2\n- Bullet 3\n`;
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
    const text = `## Fiserv — Senior Engineer (2021–2025)
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
