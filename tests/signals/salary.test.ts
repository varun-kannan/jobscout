import { describe, expect, test } from "bun:test";
import {
  compareToTarget,
  formatSalary,
  fromStructured,
  parseSalary,
  type Target,
} from "../../src/signals/salary.ts";

describe("parseSalary — western formats", () => {
  test("reads a plain dollar range", () => {
    const s = parseSalary("The salary range for this role is $150,000 - $200,000 per year.");
    expect(s.state).toBe("parsed");
    expect(s.min).toBe(150_000);
    expect(s.max).toBe(200_000);
    expect(s.currency).toBe("USD");
    expect(s.period).toBe("annual");
  });

  test("reads an en-dash range", () => {
    const s = parseSalary("Base pay: $182,208 – $236,580");
    expect(s.min).toBe(182_208);
    expect(s.max).toBe(236_580);
  });

  test("expands a trailing k across both figures", () => {
    const s = parseSalary("Compensation is 120 - 160k depending on experience");
    expect(s.min).toBe(120_000);
    expect(s.max).toBe(160_000);
  });

  test("reads a 'between X and Y' range", () => {
    const s = parseSalary("The base salary is between $140,000 and $180,000.");
    expect(s.min).toBe(140_000);
    expect(s.max).toBe(180_000);
  });

  test("picks up hourly rates", () => {
    const s = parseSalary("Pay: $45 - $65 per hour");
    expect(s.period).toBe("hourly");
    expect(s.min).toBe(45);
  });

  test("handles a single 'up to' figure", () => {
    const s = parseSalary("Salary up to £95,000");
    expect(s.state).toBe("parsed");
    expect(s.currency).toBe("GBP");
    expect(s.max).toBe(95_000);
  });
});

describe("parseSalary — Indian formats", () => {
  test("reads lakh-per-annum shorthand", () => {
    const s = parseSalary("CTC: 20 - 60 LPA");
    expect(s.min).toBe(2_000_000);
    expect(s.max).toBe(6_000_000);
    expect(s.currency).toBe("INR");
  });

  test("reads Indian digit grouping", () => {
    const s = parseSalary("Salary ₹20,00,000 - ₹60,00,000 per annum");
    expect(s.min).toBe(2_000_000);
    expect(s.max).toBe(6_000_000);
    expect(s.currency).toBe("INR");
  });

  test("reads crores", () => {
    const s = parseSalary("Package: 1 - 2 crore");
    expect(s.min).toBe(10_000_000);
    expect(s.max).toBe(20_000_000);
  });
});

describe("parseSalary — refusing to guess", () => {
  test("returns absent for a description with no pay information", () => {
    const s = parseSalary("We are a fast-growing team looking for a backend engineer.");
    expect(s.state).toBe("absent");
    expect(s.min).toBeNull();
  });

  test("returns absent for empty input", () => {
    expect(parseSalary("").state).toBe("absent");
  });

  /**
   * The failure this guard exists for: company blurbs routinely mention
   * funding, and "$13.5M raised" is not a salary.
   */
  test("does not mistake funding for compensation", () => {
    const s = parseSalary(
      "About us: we have raised $13,500,000 from top global investors and serve 2,600,000 users.",
    );
    expect(s.state).toBe("absent");
  });

  test("rejects an implausibly wide range", () => {
    const s = parseSalary("salary between $1,000 and $900,000");
    expect(s.state).toBe("absent");
  });

  test("anchors on compensation language when a blurb precedes it", () => {
    const text =
      "We raised $50,000,000 last year and have 1,000,000 customers. " +
      "The base salary range is $140,000 - $180,000.";
    const s = parseSalary(text);
    expect(s.min).toBe(140_000);
    expect(s.max).toBe(180_000);
  });
});

describe("fromStructured", () => {
  test("marks engine-supplied figures as disclosed", () => {
    const s = fromStructured({ min: 100_000, max: 140_000, currency: "USD" });
    expect(s.state).toBe("disclosed");
  });

  test("marks predicted figures as estimated, not disclosed", () => {
    const s = fromStructured({ min: 100_000, max: 140_000, currency: "USD", predicted: true });
    expect(s.state).toBe("estimated");
  });

  test("returns absent when the engine had nothing", () => {
    expect(fromStructured({ min: null, max: null }).state).toBe("absent");
  });
});

describe("compareToTarget", () => {
  const target: Target = { min: 2_000_000, max: 6_000_000, currency: "INR", period: "annual" };

  test("within when the range overlaps the target", () => {
    const s = parseSalary("CTC 30 - 45 LPA");
    expect(compareToTarget(s, target)).toBe("within");
  });

  test("below when the ceiling is under the floor", () => {
    const s = parseSalary("CTC 8 - 12 LPA");
    expect(compareToTarget(s, target)).toBe("below");
  });

  test("above when the floor is over the ceiling", () => {
    const s = parseSalary("CTC 80 - 90 LPA");
    expect(compareToTarget(s, target)).toBe("above");
  });

  test("unknown when there is no salary at all", () => {
    expect(compareToTarget(parseSalary("no pay listed"), target)).toBe("unknown");
  });

  /** Converting currencies would need live FX and would invent precision. */
  test("unknown across mismatched currencies rather than guessing", () => {
    const usd = parseSalary("Salary $150,000 - $200,000");
    expect(compareToTarget(usd, target)).toBe("unknown");
  });

  test("unknown across mismatched periods", () => {
    const hourly = parseSalary("Pay $60 - $80 per hour");
    expect(compareToTarget(hourly, target)).toBe("unknown");
  });
});

describe("formatSalary", () => {
  test("shows absence rather than a blank", () => {
    expect(formatSalary(parseSalary("nothing here"))).toBe("not stated");
  });

  test("compacts lakhs for INR", () => {
    expect(formatSalary(parseSalary("CTC 20 - 60 LPA"))).toBe("₹20L–₹60L (from text)");
  });

  test("compacts thousands for USD", () => {
    expect(formatSalary(parseSalary("Salary $150,000 - $200,000"))).toBe(
      "$150k–$200k (from text)",
    );
  });

  test("labels an estimate as an estimate", () => {
    const s = fromStructured({ min: 120_000, max: 150_000, currency: "USD", predicted: true });
    expect(formatSalary(s)).toContain("(estimated)");
  });

  test("adds no qualifier to engine-disclosed figures", () => {
    const s = fromStructured({ min: 120_000, max: 150_000, currency: "USD" });
    expect(formatSalary(s)).toBe("$120k–$150k");
  });

  test("marks an hourly rate", () => {
    expect(formatSalary(parseSalary("Pay: $45 - $65 per hour"))).toContain("/hr");
  });
});
