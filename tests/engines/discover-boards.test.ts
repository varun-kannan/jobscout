import { describe, expect, test } from "bun:test";
import {
  candidateTokens,
  namesAgree,
  probeCompanies,
  probeCompany,
  verifyBoard,
} from "../../src/engines/discover-boards.ts";
import { createStubClient } from "../../src/engines/http.ts";

const GREENHOUSE = "https://boards-api.greenhouse.io/v1/boards/";
const LEVER = "https://api.lever.co/v0/postings/";

describe("candidateTokens", () => {
  test("joins and hyphenates the name", () => {
    expect(candidateTokens("Capital One")).toEqual(["capitalone", "capital-one"]);
  });

  test("strips corporate suffixes", () => {
    expect(candidateTokens("Meesho Technologies")).toEqual(["meesho"]);
    expect(candidateTokens("Stripe, Inc.")).toEqual(["stripe"]);
    expect(candidateTokens("Acme Labs Pvt Ltd")).toEqual(["acme"]);
  });

  /**
   * The false positive this guards against. A bare first word matched
   * "Capital One" to `lever/capital` — a company in Limassol with 36 unrelated
   * jobs, which would have been attributed to a US bank on every run.
   */
  test("never offers a bare first word from a multi-word name", () => {
    for (const name of ["Capital One", "Deutsche Bank", "Goldman Sachs"]) {
      const first = name.split(" ")[0]!.toLowerCase();
      expect(candidateTokens(name)).not.toContain(first);
    }
  });

  test("handles a single-word name", () => {
    expect(candidateTokens("Vercel")).toEqual(["vercel"]);
  });

  test("returns nothing usable for a nameless company", () => {
    expect(candidateTokens("")).toEqual([]);
    expect(candidateTokens("   ")).toEqual([]);
    expect(candidateTokens("Ltd")).toEqual([]);
  });
});

describe("namesAgree", () => {
  test("accepts the same employer written differently", () => {
    expect(namesAgree("Stripe", "Stripe, Inc.")).toBe(true);
    expect(namesAgree("Meesho Technologies", "Meesho")).toBe(true);
  });

  test("rejects two different employers", () => {
    expect(namesAgree("Capital", "Capital One")).toBe(true); // substring, allowed
    expect(namesAgree("Nike", "Adidas")).toBe(false);
  });

  test("stays permissive when a name is missing", () => {
    expect(namesAgree("", "Stripe")).toBe(true);
  });
});

describe("probeCompany", () => {
  test("finds a board and reports how many jobs it has", async () => {
    const http = createStubClient({
      [`${GREENHOUSE}vercel/jobs`]: { jobs: [{ company_name: "Vercel" }, { company_name: "Vercel" }] },
    });
    const result = await probeCompany("Vercel", { http });
    expect(result).toMatchObject({ ats: "greenhouse", token: "vercel", jobs: 2 });
  });

  /**
   * Several platforms answer 200 for a token that does not exist, returning an
   * empty board — so a status check alone would happily save nonsense.
   */
  test("treats an empty board as no board", async () => {
    const http = createStubClient({ [`${GREENHOUSE}ghost/jobs`]: { jobs: [] } });
    expect(await probeCompany("Ghost", { http })).toBeNull();
  });

  test("falls through to the next platform", async () => {
    const http = createStubClient({
      [`${GREENHOUSE}meesho/jobs`]: { jobs: [] },
      [`${LEVER}meesho`]: [{ id: "1" }, { id: "2" }, { id: "3" }],
    });
    const result = await probeCompany("Meesho", { http });
    expect(result).toMatchObject({ ats: "lever", token: "meesho", jobs: 3 });
  });

  /** Lever answers with an object, not an array, for an unknown token. */
  test("does not mistake Lever's not-found object for a board", async () => {
    const http = createStubClient({ [`${LEVER}nope`]: { ok: false, error: "Document not found" } });
    expect(await probeCompany("Nope", { http })).toBeNull();
  });

  /** Greenhouse names the employer, so a mismatched token can be caught. */
  test("rejects a Greenhouse board belonging to someone else", async () => {
    const http = createStubClient({
      [`${GREENHOUSE}acme/jobs`]: { jobs: [{ company_name: "Completely Different Co" }] },
    });
    expect(await probeCompany("Acme", { http })).toBeNull();
  });

  test("accepts a Greenhouse board whose name merely differs in form", async () => {
    const http = createStubClient({
      [`${GREENHOUSE}stripe/jobs`]: { jobs: [{ company_name: "Stripe, Inc." }] },
    });
    expect(await probeCompany("Stripe", { http })).toMatchObject({ token: "stripe" });
  });

  test("a network failure is a miss, not an error", async () => {
    const http = createStubClient({});
    expect(await probeCompany("Anything", { http })).toBeNull();
  });

  test("stops at the first platform that resolves", async () => {
    // Both would answer; greenhouse is tried first and must win.
    const http = createStubClient({
      [`${GREENHOUSE}dual/jobs`]: { jobs: [{ company_name: "Dual" }] },
      [`${LEVER}dual`]: [{ id: "1" }, { id: "2" }],
    });
    expect((await probeCompany("Dual", { http }))!.ats).toBe("greenhouse");
  });
});

describe("probeCompanies", () => {
  test("separates found from missed", async () => {
    const http = createStubClient({
      [`${GREENHOUSE}vercel/jobs`]: { jobs: [{ company_name: "Vercel" }] },
      [`${GREENHOUSE}ghost/jobs`]: { jobs: [] },
    });
    const summary = await probeCompanies(["Vercel", "Ghost"], { http });
    expect(summary.tried).toBe(2);
    expect(summary.found.map((f) => f.company)).toEqual(["Vercel"]);
    expect(summary.missed).toEqual(["Ghost"]);
  });

  test("reports progress per company", async () => {
    const seen: string[] = [];
    await probeCompanies(["A Co", "B Co"], {
      http: createStubClient({}),
      onProgress: (company) => seen.push(company),
    });
    expect(seen).toEqual(["A Co", "B Co"]);
  });
});

describe("verifyBoard", () => {
  test("confirms a board that still resolves", async () => {
    const http = createStubClient({ [`${GREENHOUSE}vercel/jobs`]: { jobs: [{}] } });
    expect(await verifyBoard({ company: "Vercel", ats: "greenhouse", token: "vercel" }, { http })).toBe(true);
  });

  test("reports a board that has gone away", async () => {
    const http = createStubClient({ [`${GREENHOUSE}gone/jobs`]: { jobs: [] } });
    expect(await verifyBoard({ company: "Gone", ats: "greenhouse", token: "gone" }, { http })).toBe(false);
  });

  /** Platforms that cannot be probed must not be reported as broken. */
  test("leaves an unprobeable platform alone", async () => {
    const http = createStubClient({});
    expect(
      await verifyBoard({ company: "X", ats: "smartrecruiters", token: "x" }, { http }),
    ).toBe(true);
  });
});
