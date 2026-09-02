/**
 * Salary: finding it, and judging it against what you asked for.
 *
 * Only about a third of postings carry usable pay data — Adzuna and Foundit
 * return it structured, but a live check found pay ranges in just 11 of 588
 * Greenhouse descriptions. So the goal here is not coverage, it is honesty:
 * every job gets a definite state, and `absent` is displayed rather than left
 * blank, because a company that will not name a range has told you something.
 *
 * Pure functions, no I/O — the same rule the matcher follows.
 */

export type SalaryState = "disclosed" | "parsed" | "estimated" | "absent";
export type SalaryVerdict = "above" | "within" | "below" | "unknown";
export type SalaryPeriod = "annual" | "monthly" | "hourly";

export interface SalaryRange {
  min: number | null;
  max: number | null;
  currency: string;
  period: SalaryPeriod;
  state: SalaryState;
}

export const ABSENT: SalaryRange = {
  min: null,
  max: null,
  currency: "",
  period: "annual",
  state: "absent",
};

const CURRENCY_BY_SYMBOL: Record<string, string> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  "₹": "INR",
};

/** Multipliers for figures written as "120k" or "12 lakh". */
const SCALE_WORDS: Array<[RegExp, number]> = [
  [/^lpa$/i, 100_000], // lakhs per annum
  [/^lakhs?$/i, 100_000],
  [/^l$/i, 100_000],
  [/^crores?$/i, 10_000_000],
  [/^cr$/i, 10_000_000],
  [/^k$/i, 1_000],
  [/^m$/i, 1_000_000],
];

function applyScale(value: number, suffix: string | undefined): number {
  if (!suffix) return value;
  for (const [pattern, factor] of SCALE_WORDS) {
    if (pattern.test(suffix)) return value * factor;
  }
  return value;
}

function toNumber(raw: string): number {
  // Indian grouping ("20,00,000") and Western ("200,000") both reduce to digits.
  return Number(raw.replace(/[,\s]/g, ""));
}

/**
 * A range written as two figures, e.g.
 *   "$150,000 - $200,000"   "₹20,00,000 – ₹60,00,000"
 *   "120k to 160k"          "20 - 60 LPA"
 */
const RANGE = new RegExp(
  // Separators are word-bounded. Without that, "$13,500,000 from top global
  // investors and 2,600,000 users" parses as a range across the "to" inside
  // "top", which is how a funding figure gets mistaken for a salary.
  String.raw`([$£€₹])?\s?(\d[\d,\s]*(?:\.\d+)?)\s*([a-zA-Z]{1,6})?\s*(?:-|–|—|\bto\b|\bup\s+to\b|\band\b)\s*([$£€₹])?\s?(\d[\d,\s]*(?:\.\d+)?)\s*([a-zA-Z]{1,6})?`,
  "i",
);

/** A single figure, e.g. "up to $180,000" or "₹45 LPA". */
const SINGLE = new RegExp(
  String.raw`([$£€₹])\s?(\d[\d,\s]*(?:\.\d+)?)\s*([a-zA-Z]{1,6})?`,
  "i",
);

function detectPeriod(text: string): SalaryPeriod {
  if (/\b(per hour|hourly|\/\s?hr|\/\s?hour|an hour)\b/i.test(text)) return "hourly";
  if (/\b(per month|monthly|\/\s?mo|\/\s?month|a month|pm)\b/i.test(text)) return "monthly";
  return "annual";
}

/** Ignore matches that are obviously not compensation. */
function plausible(min: number, max: number, period: SalaryPeriod): boolean {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
  if (min <= 0 || max <= 0) return false;
  if (max < min) return false;
  // A "range" spanning more than 20x is almost certainly two unrelated numbers.
  if (max / min > 20) return false;
  if (period === "hourly") return min >= 5 && max <= 5_000;
  if (period === "monthly") return min >= 500 && max <= 10_000_000;
  return min >= 1_000 && max <= 100_000_000;
}

/**
 * Pull a pay range out of free text.
 *
 * Returns state 'parsed' on success — never 'disclosed', which is reserved for
 * figures an engine handed over as structured data.
 */
export function parseSalary(text: string, fallbackCurrency = ""): SalaryRange {
  if (!text) return ABSENT;

  // Look only near compensation language, so an unrelated "$2,000,000 raised
  // from investors" in the company blurb is not mistaken for a salary.
  const cueIndex = text.search(
    /\b(salary|compensation|pay range|pay|base|remuneration|ctc|package|offers?)\b/i,
  );
  const haystack = cueIndex >= 0 ? text.slice(cueIndex, cueIndex + 400) : text.slice(0, 400);
  const period = detectPeriod(haystack);

  const range = RANGE.exec(haystack);
  if (range) {
    const [, sym1, lo, loSuffix, sym2, hi, hiSuffix] = range;
    // "120 - 160k" means both figures are thousands.
    const suffix = hiSuffix ?? loSuffix;
    const min = applyScale(toNumber(lo!), loSuffix ?? suffix);
    const max = applyScale(toNumber(hi!), suffix);
    if (plausible(min, max, period)) {
      const currency =
        CURRENCY_BY_SYMBOL[sym1 ?? sym2 ?? ""] ??
        (/(lpa|lakh|crore)/i.test(suffix ?? "") ? "INR" : fallbackCurrency);
      return { min, max, currency, period, state: "parsed" };
    }
    // A range was found and judged implausible. Falling through to the
    // single-figure branch would report one half of a rejected pair as the
    // salary, which is worse than reporting nothing.
    return ABSENT;
  }

  // A lone number is only compensation if compensation was being discussed.
  // Without that anchor, any large figure in a company blurb qualifies.
  if (cueIndex < 0) return ABSENT;

  const single = SINGLE.exec(haystack);
  if (single) {
    const [, sym, num, suffix] = single;
    const value = applyScale(toNumber(num!), suffix);
    if (plausible(value, value, period)) {
      return {
        min: value,
        max: value,
        currency: CURRENCY_BY_SYMBOL[sym ?? ""] ?? fallbackCurrency,
        period,
        state: "parsed",
      };
    }
  }

  return ABSENT;
}

/** Build a range from figures an engine returned as structured fields. */
export function fromStructured(opts: {
  min: number | null | undefined;
  max: number | null | undefined;
  currency?: string;
  period?: SalaryPeriod;
  predicted?: boolean;
}): SalaryRange {
  const { min, max } = opts;
  if ((min == null || !Number.isFinite(min)) && (max == null || !Number.isFinite(max))) {
    return ABSENT;
  }
  return {
    min: min ?? null,
    max: max ?? null,
    currency: opts.currency ?? "",
    period: opts.period ?? "annual",
    // Adzuna flags predicted figures; showing them as disclosed would be a lie.
    state: opts.predicted ? "estimated" : "disclosed",
  };
}

export interface Target {
  min: number | null;
  max: number | null;
  currency: string;
  period: SalaryPeriod;
}

/**
 * How this pay compares with what you asked for.
 *
 * Returns 'unknown' rather than guessing whenever the comparison would be
 * meaningless — no figure, no target, or a currency mismatch. Converting
 * currencies would need live FX rates and would quietly invent precision.
 */
export function compareToTarget(salary: SalaryRange, target: Target): SalaryVerdict {
  if (salary.state === "absent") return "unknown";
  if (target.min == null && target.max == null) return "unknown";
  if (salary.period !== target.period) return "unknown";
  if (salary.currency && target.currency && salary.currency !== target.currency) return "unknown";

  const top = salary.max ?? salary.min;
  const bottom = salary.min ?? salary.max;
  if (top == null || bottom == null) return "unknown";

  if (target.min != null && top < target.min) return "below";
  if (target.max != null && bottom > target.max) return "above";
  return "within";
}

const SYMBOL_BY_CURRENCY: Record<string, string> = {
  USD: "$",
  GBP: "£",
  EUR: "€",
  INR: "₹",
};

function compact(value: number, currency: string): string {
  if (currency === "INR") {
    if (value >= 10_000_000) return `${+(value / 10_000_000).toFixed(2)}Cr`;
    if (value >= 100_000) return `${+(value / 100_000).toFixed(2)}L`;
  }
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** One short line for the review screen. Never blank — absence is displayed. */
export function formatSalary(salary: SalaryRange): string {
  if (salary.state === "absent") return "not stated";

  const sym = SYMBOL_BY_CURRENCY[salary.currency] ?? "";
  const suffix = salary.period === "annual" ? "" : salary.period === "monthly" ? "/mo" : "/hr";
  const body =
    salary.min != null && salary.max != null && salary.min !== salary.max
      ? `${sym}${compact(salary.min, salary.currency)}–${sym}${compact(salary.max, salary.currency)}`
      : `${sym}${compact((salary.min ?? salary.max)!, salary.currency)}`;

  const qualifier =
    salary.state === "estimated" ? " (estimated)" : salary.state === "parsed" ? " (from text)" : "";

  return `${body}${suffix}${qualifier}`;
}
