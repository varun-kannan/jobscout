import { describe, expect, test } from "bun:test";
import {
  salaryState,
  salaryVsTarget,
  remoteReality,
  toAnnual,
  describeSalary,
  type JobPay,
  type PayTarget,
} from "../../src/signals/compute.ts";

const target: PayTarget = { salaryMin: 100_000, salaryCurrency: "USD", salaryPeriod: "annual" };

function pay(over: Partial<JobPay> = {}): JobPay {
  return {
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: "USD",
    salaryPeriod: "annual",
    ...over,
  };
}

describe("salaryState", () => {
  test("tells a range from a single figure from silence", () => {
    expect(salaryState(pay({ salaryMin: 100, salaryMax: 200 }))).toBe("range");
    expect(salaryState(pay({ salaryMin: 100 }))).toBe("single");
    expect(salaryState(pay({ salaryMin: 100, salaryMax: 100 }))).toBe("single");
    expect(salaryState(pay())).toBe("absent");
  });
});

describe("toAnnual", () => {
  test("puts every period on the same footing", () => {
    expect(toAnnual(120_000, "annual")).toBe(120_000);
    expect(toAnnual(10_000, "monthly")).toBe(120_000);
  });

  /** A working year, not 8,760 hours — the naive version understates by 4x. */
  test("an hourly rate is a working year", () => {
    expect(toAnnual(50, "hourly")).toBe(104_000);
  });

  test("refuses a period it does not know", () => {
    expect(toAnnual(100, "fortnightly")).toBeNull();
  });
});

describe("salaryVsTarget", () => {
  test("compares against the top of a band, which is what they will pay", () => {
    // Bottom is under target, top is over: open to paying what you asked.
    expect(salaryVsTarget(pay({ salaryMin: 80_000, salaryMax: 140_000 }), target)).toBe("above");
  });

  test("reads above, meets, and below", () => {
    expect(salaryVsTarget(pay({ salaryMin: 150_000 }), target)).toBe("above");
    expect(salaryVsTarget(pay({ salaryMin: 100_000 }), target)).toBe("meets");
    expect(salaryVsTarget(pay({ salaryMin: 70_000 }), target)).toBe("below");
  });

  /** A figure a rounding away from the floor is not a rejection. */
  test("allows a little slack around the floor", () => {
    expect(salaryVsTarget(pay({ salaryMin: 99_000 }), target)).toBe("meets");
  });

  /**
   * Converting would invent an exchange rate, and the output would look
   * exactly like a real comparison. Unknown is the honest answer.
   */
  test("never converts between currencies", () => {
    expect(salaryVsTarget(pay({ salaryMin: 9_000_000, salaryCurrency: "INR" }), target)).toBe(
      "unknown",
    );
    expect(salaryVsTarget(pay({ salaryMin: 150_000, salaryCurrency: null }), target)).toBe(
      "unknown",
    );
  });

  test("is unknown when either side is silent", () => {
    expect(salaryVsTarget(pay(), target)).toBe("unknown");
    expect(
      salaryVsTarget(pay({ salaryMin: 150_000 }), { ...target, salaryMin: null }),
    ).toBe("unknown");
  });

  test("compares a monthly posting with an annual target correctly", () => {
    expect(salaryVsTarget(pay({ salaryMin: 12_000, salaryPeriod: "monthly" }), target)).toBe(
      "above",
    );
    expect(salaryVsTarget(pay({ salaryMin: 5_000, salaryPeriod: "monthly" }), target)).toBe(
      "below",
    );
  });
});

describe("remoteReality", () => {
  /** "Remote (US only)" is not remote if you are not in the US. */
  test("separates real remote from a restricted one", () => {
    expect(remoteReality({ remote: true, remoteRestriction: null })).toBe("remote");
    expect(remoteReality({ remote: true, remoteRestriction: "US only" })).toBe("restricted");
    expect(remoteReality({ remote: true, remoteRestriction: "  " })).toBe("remote");
  });

  test("keeps 'not stated' distinct from 'not remote'", () => {
    expect(remoteReality({ remote: false, remoteRestriction: null })).toBe("hybrid-or-onsite");
    expect(remoteReality({ remote: null, remoteRestriction: null })).toBe("unstated");
  });
});

describe("describeSalary", () => {
  test("says when pay is not stated rather than showing an empty range", () => {
    expect(describeSalary(pay(), "unknown")).toBe("pay not stated");
  });

  test("renders a band and how it lands against your floor", () => {
    const text = describeSalary(pay({ salaryMin: 120_000, salaryMax: 160_000 }), "above");
    expect(text).toContain("120,000");
    expect(text).toContain("160,000");
    expect(text).toContain("above target");
  });

  test("marks a non-annual period so a figure is never misread", () => {
    expect(describeSalary(pay({ salaryMin: 9_000, salaryPeriod: "monthly" }), "unknown")).toContain(
      "/monthly",
    );
  });
});
