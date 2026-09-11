import { describe, expect, test } from "bun:test";
import { classifyCompany } from "../../src/signals/company-type.ts";

describe("classifyCompany", () => {
  /**
   * The distinction that matters most: a staffing firm posts the same titles as
   * the employer, and "our client" is how it gives itself away.
   */
  test("catches a staffing post from its placement language", () => {
    expect(classifyCompany("Acme Tech", "Our client, a leading bank, seeks…").type).toBe("staffing");
    expect(classifyCompany("Acme", "This is a contract-to-hire role.").type).toBe("staffing");
    expect(classifyCompany("Acme", "Looking for W2 candidates only.").type).toBe("staffing");
  });

  test("recognises a recruitment agency", () => {
    expect(classifyCompany("X", "We are a recruitment agency working with…").type).toBe("agency");
  });

  test("recognises a product company from how it talks about itself", () => {
    expect(classifyCompany("Stripe", "You will ship features our customers rely on daily.").type)
      .toBe("product");
    expect(classifyCompany("Acme", "A fast-growing SaaS business.").type).toBe("product");
  });

  test("recognises services and consultancies", () => {
    expect(classifyCompany("X", "We are an IT services and systems integration firm.").type)
      .toBe("service");
    expect(classifyCompany("X", "Our consultants work on client engagements.").type)
      .toBe("consultancy");
  });

  test("recognises a nonprofit", () => {
    expect(classifyCompany("X", "We are a registered non-profit.").type).toBe("nonprofit");
  });

  /** A staffing firm often calls itself a consultancy; the posting text wins. */
  test("placement language beats a consultancy name", () => {
    const r = classifyCompany("Bright Consulting", "Our client is hiring a backend engineer.");
    expect(r.type).toBe("staffing");
  });

  test("falls back to the name when the text says nothing", () => {
    expect(classifyCompany("Sunrise Staffing", "Backend engineer needed.").type).toBe("staffing");
    expect(classifyCompany("Zenith Consulting", "Backend engineer needed.").type).toBe("consultancy");
  });

  /**
   * "… Technologies" is a weak signal — plenty of product companies are named
   * that way — so it is flagged uncertain rather than asserted.
   */
  test("marks a name-only service guess as uncertain", () => {
    const r = classifyCompany("Meridian Technologies", "Backend engineer needed.");
    expect(r.type).toBe("service");
    expect(r.uncertain).toBe(true);
  });

  /** Guessing "product" because it is commonest would be worse than saying so. */
  test("says unknown rather than guessing", () => {
    const r = classifyCompany("Acme", "Backend engineer. Five years experience.");
    expect(r.type).toBe("unknown");
    expect(r.uncertain).toBe(true);
  });

  test("always gives a reason that can be argued with", () => {
    for (const [co, text] of [["Acme", "Our client is hiring."], ["Acme", "nothing here"]]) {
      expect(classifyCompany(co!, text!).reason.length).toBeGreaterThan(0);
    }
  });

  test("does not read the whole of a very long posting", () => {
    const padded = "x".repeat(20_000) + " our client ";
    expect(classifyCompany("Acme", padded).type).toBe("unknown");
  });
});
