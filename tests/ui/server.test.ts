import { describe, expect, test } from "bun:test";
import { filtersFrom } from "../../src/ui/server.ts";

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

  test("remoteOnly is only true for an explicit 1", () => {
    expect(at("?remoteOnly=0").remoteOnly).toBe(false);
    expect(at("?remoteOnly=true").remoteOnly).toBe(false);
    expect(at("?remoteOnly=1").remoteOnly).toBe(true);
  });
});
