import { describe, expect, test } from "bun:test";
import { fingerprintOf } from "../../src/skills/fingerprint.ts";

describe("fingerprintOf", () => {
  /** Re-extracting the same résumé must not invalidate every ranking. */
  test("the same skills always give the same fingerprint", () => {
    const a = [{ slug: "go", level: "strong" }, { slug: "sql", level: "working" }];
    expect(fingerprintOf(a)).toBe(fingerprintOf([...a]));
  });

  test("row order cannot change the answer", () => {
    const a = [{ slug: "go", level: "strong" }, { slug: "sql", level: "working" }];
    const b = [{ slug: "sql", level: "working" }, { slug: "go", level: "strong" }];
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  test("adding a skill changes it", () => {
    const a = [{ slug: "go", level: "strong" }];
    const b = [...a, { slug: "sql", level: "working" }];
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(b));
  });

  /** Depth feeds the score, so a changed level is a changed profile. */
  test("changing a level changes it", () => {
    expect(fingerprintOf([{ slug: "go", level: "exposure" }]))
      .not.toBe(fingerprintOf([{ slug: "go", level: "strong" }]));
  });

  test("an empty profile has its own stable value", () => {
    expect(fingerprintOf([])).toBe("empty");
  });
});
