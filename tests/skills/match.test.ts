import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WEIGHTS,
  explainMatch,
  matchJob,
  type JobSkill,
  type ProfileSkill,
  type SkillLevel,
} from "../../src/skills/match.ts";
import type { SkillCategory } from "../../src/skills/canonical.ts";

function held(slug: string, level: SkillLevel = "strong", category: SkillCategory = "language"): ProfileSkill {
  return { slug, label: slug, category, level };
}

function wants(slug: string, requirement: "required" | "preferred" = "required"): JobSkill {
  return { slug, label: slug, requirement };
}

function score(profile: ProfileSkill[], job: JobSkill[], extra = {}) {
  return matchJob({ profile, job, weights: DEFAULT_WEIGHTS, ...extra });
}

describe("counting", () => {
  test("counts matched and missing required skills", () => {
    const result = score(
      [held("go"), held("postgresql")],
      [wants("go"), wants("postgresql"), wants("kafka")],
    );
    expect(result.matchedRequired).toBe(2);
    expect(result.totalRequired).toBe(3);
    expect(result.coverage).toBeCloseTo(2 / 3, 5);
    expect(result.matched).toEqual(["go", "postgresql"]);
    expect(result.missing).toEqual(["kafka"]);
  });

  test("keeps preferred skills in a separate tally", () => {
    const result = score(
      [held("go"), held("docker")],
      [wants("go"), wants("docker", "preferred"), wants("kafka", "preferred")],
    );
    expect(result.matchedRequired).toBe(1);
    expect(result.totalRequired).toBe(1);
    expect(result.matchedPreferred).toBe(1);
    expect(result.totalPreferred).toBe(2);
  });

  test("coverage is the plain proportion, not the weighted one", () => {
    // Two of two matched, but both only at exposure level.
    const result = score(
      [held("go", "exposure"), held("kafka", "exposure")],
      [wants("go"), wants("kafka")],
    );
    expect(result.coverage).toBe(1);
    // The score still reflects shallow depth.
    expect(result.components.weightedRequired).toBeLessThan(1);
  });

  test("reports strengths the posting did not ask for", () => {
    const result = score(
      [held("go"), held("payments", "expert", "domain"), held("redis", "exposure")],
      [wants("go")],
    );
    expect(result.bonus).toContain("payments");
    // Shallow skills are not worth mentioning as a strength.
    expect(result.bonus).not.toContain("redis");
  });
});

describe("depth weighting", () => {
  test("deeper experience in the same skills scores higher", () => {
    const job = [wants("go"), wants("postgresql")];
    const shallow = score([held("go", "exposure"), held("postgresql", "exposure")], job);
    const deep = score([held("go", "expert"), held("postgresql", "expert")], job);
    expect(deep.matchScore).toBeGreaterThan(shallow.matchScore);
    // Both matched everything, so the plain counts are identical.
    expect(deep.coverage).toBe(shallow.coverage);
  });

  test("expert and strong are treated as equally sufficient", () => {
    const job = [wants("go")];
    expect(score([held("go", "expert")], job).matchScore).toBeCloseTo(
      score([held("go", "strong")], job).matchScore,
      6,
    );
  });
});

describe("guarding against nonsense scores", () => {
  /**
   * An empty intersection is an absence of evidence, not a perfect fit. If a
   * posting with no listed requirements scored 1, every skill-less posting
   * would float to the top of the list.
   */
  test("a posting with no requirements scores zero, not one", () => {
    const result = score([held("go")], []);
    expect(result.matchScore).toBe(0);
    expect(result.totalRequired).toBe(0);
  });

  test("an empty profile scores zero without throwing", () => {
    const result = score([], [wants("go"), wants("kafka")]);
    expect(result.matchScore).toBeGreaterThanOrEqual(0);
    expect(result.matchedRequired).toBe(0);
    expect(result.missing).toHaveLength(2);
  });

  test("the score never leaves 0..1", () => {
    const many = Array.from({ length: 40 }, (_, i) => held(`skill${i}`, "expert"));
    const asked = many.map((s) => wants(s.slug));
    const result = score(many, asked, { seniority: { yours: 30, theirs: 1 }, domains: ["payments"] });
    expect(result.matchScore).toBeLessThanOrEqual(1);
    expect(result.matchScore).toBeGreaterThanOrEqual(0);
  });

  test("is reproducible — same inputs, same score", () => {
    const profile = [held("go"), held("postgresql", "working")];
    const job = [wants("go"), wants("kafka"), wants("redis", "preferred")];
    const a = score(profile, job);
    const b = score(profile, job);
    expect(a).toEqual(b);
  });
});

describe("seniority fit", () => {
  const job = [wants("go")];

  test("a role at your level fits", () => {
    const result = score([held("go")], job, { seniority: { yours: 7, theirs: 7 } });
    expect(result.components.seniority).toBe(1);
  });

  test("being under-qualified costs more than being over-qualified", () => {
    const under = score([held("go")], job, { seniority: { yours: 2, theirs: 7 } });
    const over = score([held("go")], job, { seniority: { yours: 12, theirs: 7 } });
    expect(over.components.seniority).toBeGreaterThan(under.components.seniority);
  });

  test("no information yields a neutral value, not a verdict", () => {
    expect(score([held("go")], job, {}).components.seniority).toBe(0.5);
    expect(score([held("go")], job, { seniority: { yours: 5 } }).components.seniority).toBe(0.5);
  });
});

describe("domain affinity", () => {
  test("rewards a role in a domain you work in", () => {
    const profile = [held("go"), held("payments", "expert", "domain")];
    const inDomain = score(profile, [wants("go"), wants("payments")], { domains: ["payments"] });
    const outOfDomain = score(profile, [wants("go"), wants("gaming")], { domains: ["payments"] });
    expect(inDomain.components.domain).toBeGreaterThan(outOfDomain.components.domain);
  });

  test("stays neutral when the posting names no domain", () => {
    const result = score([held("go")], [wants("go")], { domains: ["payments"] });
    expect(result.components.domain).toBe(0.5);
  });
});

describe("evidence smoothing", () => {
  /**
   * The failure this exists for. Ranking a real corpus put "Legal Entity
   * Controller" and "Account Executive" at 100% — each listed one requirement,
   * it happened to be one that was held, and they outranked a backend role
   * matching nine of eleven.
   */
  test("a thorough match outranks a thin perfect one", () => {
    const thin = score([held("payments", "strong", "domain")], [wants("payments")]);
    const thorough = score(
      ["go", "postgresql", "aws", "docker", "java", "sql", "redis", "rest", "microservices"].map((s) =>
        held(s),
      ),
      ["go", "postgresql", "aws", "docker", "java", "sql", "redis", "rest", "microservices", "kafka", "terraform"].map(
        (s) => wants(s),
      ),
    );

    expect(thin.coverage).toBe(1);
    expect(thorough.coverage).toBeLessThan(1);
    // Yet the thorough match must rank higher.
    expect(thorough.matchScore).toBeGreaterThan(thin.matchScore);
  });

  test("confidence grows with the number of requirements matched", () => {
    const one = score([held("go")], [wants("go")]);
    const three = score(["go", "java", "sql"].map((s) => held(s)), ["go", "java", "sql"].map((s) => wants(s)));
    const eight = score(
      ["go", "java", "sql", "aws", "docker", "redis", "rest", "python"].map((s) => held(s)),
      ["go", "java", "sql", "aws", "docker", "redis", "rest", "python"].map((s) => wants(s)),
    );

    expect(three.matchScore).toBeGreaterThan(one.matchScore);
    expect(eight.matchScore).toBeGreaterThan(three.matchScore);
    // All three matched everything they were asked.
    expect([one, three, eight].every((r) => r.coverage === 1)).toBe(true);
  });

  test("the displayed count stays honest even though the score is smoothed", () => {
    const result = score([held("go")], [wants("go")]);
    // What the review screen shows is the plain truth: 1 of 1.
    expect(result.matchedRequired).toBe(1);
    expect(result.totalRequired).toBe(1);
    expect(result.coverage).toBe(1);
    // The score is what encodes the lack of evidence.
    expect(result.components.weightedRequired).toBeLessThan(0.5);
  });
});

describe("ordering", () => {
  /** The property the whole list depends on: better fit ranks higher. */
  test("a closer match outranks a weaker one", () => {
    const job = [wants("go"), wants("postgresql"), wants("kafka"), wants("aws")];
    const strong = score([held("go"), held("postgresql"), held("kafka"), held("aws")], job);
    const partial = score([held("go"), held("postgresql")], job);
    const weak = score([held("go")], job);

    expect(strong.matchScore).toBeGreaterThan(partial.matchScore);
    expect(partial.matchScore).toBeGreaterThan(weak.matchScore);
  });

  test("matching required beats matching the same number of preferred", () => {
    const requiredHit = score([held("go")], [wants("go"), wants("kafka", "preferred")]);
    const preferredHit = score([held("kafka")], [wants("go"), wants("kafka", "preferred")]);
    expect(requiredHit.matchScore).toBeGreaterThan(preferredHit.matchScore);
  });
});

describe("explainMatch", () => {
  test("states the counts", () => {
    const result = score([held("go")], [wants("go"), wants("kafka")]);
    expect(explainMatch(result)).toBe("1/2 required (50%)");
  });

  test("includes preferred when the posting has any", () => {
    const result = score([held("go")], [wants("go"), wants("redis", "preferred")]);
    expect(explainMatch(result)).toContain("0/1 preferred");
  });

  test("says so plainly when nothing was asked for", () => {
    expect(explainMatch(score([held("go")], []))).toBe("no requirements listed");
  });
});
