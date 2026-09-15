import { describe, expect, test } from "bun:test";
import { filtersFrom, resumeExtension } from "../../src/ui/server.ts";

const at = (query: string) => filtersFrom(new URL("http://127.0.0.1/api/jobs" + query));

describe("filtersFrom", () => {
  test("reads the filters the page sends", () => {
    const f = at("?q=stripe&location=Chennai&status=approved&minAiScore=4&remoteOnly=1");
    expect(f.q).toBe("stripe");
    expect(f.location).toBe("Chennai");
    expect(f.status).toBe("approved");
    expect(f.minAiScore).toBe(4);
    expect(f.remoteOnly).toBe(true);
  });

  test("an absent filter is undefined, not an empty string", () => {
    const f = at("");
    expect(f.q).toBeUndefined();
    expect(f.minAiScore).toBeUndefined();
    expect(f.remoteOnly).toBe(false);
  });

  /**
   * A sort value reaches SQL, so only names in the fixed map may survive.
   * Anything else becomes undefined and the query falls back to its default.
   */
  test("drops a sort it does not recognise", () => {
    expect(at("?sort=score").sort).toBe("score");
    expect(at("?sort=coverage").sort).toBe("coverage");
    expect(at("?sort=; DROP TABLE jobs").sort).toBeUndefined();
    expect(at("?sort=salary_min").sort).toBeUndefined();
  });

  /** A non-numeric limit must not become NaN and reach the query. */
  test("ignores numbers it cannot parse", () => {
    expect(at("?limit=abc").limit).toBeUndefined();
    expect(at("?minAiScore=").minAiScore).toBeUndefined();
    expect(at("?limit=50").limit).toBe(50);
  });

  test("reads a posted-within window as a number of days", () => {
    expect(at("?postedWithin=7").postedWithinDays).toBe(7);
    expect(at("?postedWithin=").postedWithinDays).toBeUndefined();
    expect(at("?postedWithin=soon").postedWithinDays).toBeUndefined();
  });

  test("remoteOnly is only true for an explicit 1", () => {
    expect(at("?remoteOnly=0").remoteOnly).toBe(false);
    expect(at("?remoteOnly=true").remoteOnly).toBe(false);
    expect(at("?remoteOnly=1").remoteOnly).toBe(true);
  });
});

describe("resumeExtension", () => {
  test("accepts the formats the extractor can read", () => {
    expect(resumeExtension("cv.pdf")).toBe(".pdf");
    expect(resumeExtension("CV.PDF")).toBe(".pdf");
    expect(resumeExtension("resume.docx")).toBe(".docx");
    expect(resumeExtension("notes.md")).toBe(".md");
  });

  test("refuses anything else rather than saving it", () => {
    expect(resumeExtension("payload.exe")).toBeNull();
    expect(resumeExtension("archive.zip")).toBeNull();
    expect(resumeExtension("noextension")).toBeNull();
  });

  /** An upload with no filename crashed this with "undefined is not an object". */
  test("survives a missing or non-string filename", () => {
    expect(resumeExtension(undefined)).toBeNull();
    expect(resumeExtension(null)).toBeNull();
    expect(resumeExtension(42)).toBeNull();
  });

  /**
   * Only the extension is ever used. The name itself must never reach the
   * filesystem, or an upload could choose where it lands.
   */
  test("a traversal attempt yields only an extension", () => {
    expect(resumeExtension("../../../../etc/passwd.pdf")).toBe(".pdf");
    expect(resumeExtension("../../.ssh/authorized_keys")).toBeNull();
  });
});
