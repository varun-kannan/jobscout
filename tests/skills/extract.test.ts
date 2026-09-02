import { describe, expect, test } from "bun:test";
import { extractSkills, normaliseSkillList } from "../../src/skills/extract.ts";
import { AliasResolver, slugifySkill } from "../../src/skills/aliases.ts";

const slugs = (text: string) => extractSkills(text).map((s) => s.slug).sort();

describe("alias resolution", () => {
  const resolver = new AliasResolver();

  test("collapses the spellings of one skill", () => {
    for (const spelling of ["Postgres", "PostgreSQL", "psql", "postgre sql"]) {
      expect(resolver.resolve(spelling)).toBe("postgresql");
    }
  });

  test("resolves common shorthand", () => {
    expect(resolver.resolve("golang")).toBe("go");
    expect(resolver.resolve("k8s")).toBe("kubernetes");
    expect(resolver.resolve("JS")).toBe("javascript");
    expect(resolver.resolve("springboot")).toBe("spring-boot");
  });

  /** Symbols carry meaning in technology names and must survive slugging. */
  test("keeps C++ and C# distinct from C", () => {
    expect(resolver.resolve("C++")).toBe("cpp");
    expect(resolver.resolve("C#")).toBe("csharp");
    expect(resolver.resolve("C")).toBe("c");
    expect(slugifySkill("C++")).not.toBe(slugifySkill("C"));
  });

  test("gives an unknown skill a stable key rather than discarding it", () => {
    const first = resolver.resolve("Bubbletea");
    expect(first).toBe("bubbletea");
    expect(resolver.resolve("bubbletea")).toBe(first);
  });

  test("ignores noise", () => {
    expect(resolver.resolve("")).toBeNull();
    expect(resolver.resolve("   ")).toBeNull();
    expect(resolver.resolve("a")).toBeNull();
  });

  test("learns a new spelling", () => {
    const r = new AliasResolver();
    expect(r.learn("pgsql", "postgresql")).toBe(true);
    expect(r.resolve("pgsql")).toBe("postgresql");
  });

  /**
   * Sources supply synonym maps, and a bad one must not be able to redefine
   * the shipped vocabulary — "java means COBOL" has to be refused.
   */
  test("refuses to redefine a shipped alias", () => {
    const r = new AliasResolver();
    expect(r.learn("java", "cobol")).toBe(false);
    expect(r.resolve("java")).toBe("java");
  });

  test("accepts aliases loaded from storage", () => {
    const r = new AliasResolver([["pgsql", "postgresql"]]);
    expect(r.resolve("PGSQL")).toBe("postgresql");
  });
});

describe("extracting from prose", () => {
  test("finds skills named in a description", () => {
    const found = slugs("We build services in Go and Python, backed by PostgreSQL and Redis.");
    expect(found).toEqual(["go", "postgresql", "python", "redis"]);
  });

  /** Without longest-first matching, "spring" swallows "spring boot". */
  test("prefers the more specific skill", () => {
    expect(slugs("Experience with Spring Boot required.")).toContain("spring-boot");
  });

  test("does not match a skill inside a longer word", () => {
    // "Rust" must not be found in "trusted", nor "go" in "algorithm".
    const found = slugs("A trusted algorithm for cargo logistics.");
    expect(found).not.toContain("rust");
    expect(found).not.toContain("go");
  });

  test("matches symbol-bearing names at a word boundary", () => {
    expect(slugs("Strong C# and C++ background")).toEqual(["c", "cpp", "csharp"].filter((s) => s !== "c"));
  });

  test("returns nothing for text with no skills", () => {
    expect(extractSkills("We are a friendly team who value curiosity.")).toEqual([]);
    expect(extractSkills("")).toEqual([]);
  });

  test("categorises what it finds", () => {
    const byCategory = Object.fromEntries(
      extractSkills("Java on AWS with Kafka, for a payments platform.").map((s) => [s.slug, s.category]),
    );
    expect(byCategory.java).toBe("language");
    expect(byCategory.aws).toBe("cloud");
    expect(byCategory.kafka).toBe("datastore");
    expect(byCategory.payments).toBe("domain");
  });
});

describe("names that are also ordinary words", () => {
  /**
   * The false positive this exists for: a go-to-market operations posting
   * reading "Go beyond code — help users set up their teams" was credited
   * with the Go programming language and ranked top of a real corpus.
   */
  test("rejects the language when the word is a verb", () => {
    for (const text of [
      "Go beyond code—help users set up their teams for success",
      "Drive go-to-market strategy for the region",
      "We will go through your application quickly",
      "Candidates must be willing to go the extra mile",
      // A cue word near the term is not the same as a cue word before it.
      // Allowing slack let the preposition "in" fire from 19 characters away.
      "participate in projects defining go-to-market approaches",
      "ensure they hit their planned go-live dates",
      // A colon in front is not enough: what follows the word decides it.
      "operational readiness: Go beyond code—help users set up their teams",
    ]) {
      expect(slugs(text)).not.toContain("go");
    }
  });

  test("accepts it when the context makes it a technology", () => {
    for (const text of [
      "Backend services written in Go and Python",
      "Java, Go, Python, and PostgreSQL",
      "Tech stack: Go/Rust/Postgres",
      "Looking for a Go developer",
      "Experience with Go required",
      "Requirements: Go and Kubernetes",
      "Proficiency in Go is essential",
    ]) {
      expect(slugs(text)).toContain("go");
    }
  });

  /** An unambiguous spelling needs no supporting context. */
  test("accepts an unambiguous alias outright", () => {
    expect(slugs("Strong Golang background")).toContain("go");
  });

  test("applies the same care to other word-like names", () => {
    expect(slugs("A swift response is expected from all applicants")).not.toContain("swift");
    expect(slugs("Mobile apps built in Swift and Kotlin")).toContain("swift");

    expect(slugs("You will dart between teams as needed")).not.toContain("dart");
    expect(slugs("Flutter and Dart experience")).toContain("dart");
  });

  test("still finds unambiguous skills in the same sentence", () => {
    // The guard must not suppress its neighbours.
    const found = slugs("We will go through your PostgreSQL and Kafka setup");
    expect(found).toContain("postgresql");
    expect(found).toContain("kafka");
    expect(found).not.toContain("go");
  });
});

describe("required versus preferred", () => {
  const posting = `
    About the role
    We are hiring a backend engineer.

    Requirements
    Strong experience with Go and PostgreSQL.

    Nice to have
    Familiarity with Kafka and Terraform.
  `;

  test("splits on the section a skill appears in", () => {
    const found = Object.fromEntries(extractSkills(posting).map((s) => [s.slug, s.requirement]));
    expect(found.go).toBe("required");
    expect(found.postgresql).toBe("required");
    expect(found.kafka).toBe("preferred");
    expect(found.terraform).toBe("preferred");
  });

  test("defaults to required when no cue is present", () => {
    const found = extractSkills("You will work in Go.");
    expect(found[0]?.requirement).toBe("required");
  });

  /** A later "nice to have" heading governs what follows it, not the whole page. */
  test("the nearest preceding cue wins", () => {
    const text = "Requirements: Go. Nice to have: Rust. ";
    const found = Object.fromEntries(extractSkills(text).map((s) => [s.slug, s.requirement]));
    expect(found.go).toBe("required");
    expect(found.rust).toBe("preferred");
  });

  test("flat mode skips the split entirely", () => {
    // A résumé has no required/preferred distinction to make.
    const found = extractSkills("Nice to have: Go", { flat: true });
    expect(found[0]?.requirement).toBe("required");
  });
});

describe("normalising a supplied list", () => {
  test("resolves a source's own skill list", () => {
    const found = normaliseSkillList(["Golang", "Postgres", "K8s"]);
    expect(found.map((s) => s.slug).sort()).toEqual(["go", "kubernetes", "postgresql"]);
  });

  test("collapses duplicates that differ only in spelling", () => {
    const found = normaliseSkillList(["Postgres", "PostgreSQL", "psql"]);
    expect(found).toHaveLength(1);
  });

  test("keeps the original wording as evidence", () => {
    const found = normaliseSkillList(["Golang"]);
    expect(found[0]?.evidence).toBe("Golang");
  });

  test("survives an empty or junk list", () => {
    expect(normaliseSkillList([])).toEqual([]);
    expect(normaliseSkillList(["", "  ", "-"])).toEqual([]);
  });
});
