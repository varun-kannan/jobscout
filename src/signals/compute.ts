/**
 * The parts of a signal that are arithmetic, not judgement.
 *
 * Pay and remote status are stated facts when a posting states them, so they
 * are settled here rather than asked of a model. Only the reading of tone —
 * what the wording suggests about working there — is left to `signals.md`.
 *
 * Every function refuses to guess. A salary in a currency that is not yours is
 * "unknown", not a converted estimate: an invented exchange rate would read
 * exactly like a real comparison.
 */

/** Whether the posting says anything about pay. */
export type SalaryState = "range" | "single" | "absent";

/** How the stated pay compares with the floor you set. */
/** Mirrors the CHECK constraint on signals.salary_vs_target exactly. */
export type SalaryVsTarget = "above" | "within" | "below" | "unknown";

/** Whether "remote" means remote. */
export type RemoteReality = "remote" | "restricted" | "hybrid-or-onsite" | "unstated";

export interface JobPay {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
}

export interface PayTarget {
  salaryMin: number | null;
  salaryCurrency: string;
  salaryPeriod: string;
}

/** Periods per year, for putting a stated figure on the same footing as yours. */
const PER_YEAR: Record<string, number> = {
  annual: 1,
  monthly: 12,
  // A working year, not 8,760 hours. Anything else understates hourly pay by
  // a factor of four and would report real offers as below target.
  hourly: 52 * 40,
};

export function salaryState(job: JobPay): SalaryState {
  if (job.salaryMin != null && job.salaryMax != null && job.salaryMax !== job.salaryMin)
    return "range";
  if (job.salaryMin != null || job.salaryMax != null) return "single";
  return "absent";
}

/** Convert a stated figure to an annual one. Null when the period is unknown. */
export function toAnnual(amount: number, period: string | null): number | null {
  const per = PER_YEAR[(period ?? "annual").toLowerCase()];
  return per === undefined ? null : Math.round(amount * per);
}

/**
 * Compare stated pay with your floor.
 *
 * The top of a range is used, because that is what the employer is willing to
 * pay someone who fits — judging a posting by the bottom of its band would
 * reject roles that are open to paying exactly what you asked for.
 */
export function salaryVsTarget(job: JobPay, target: PayTarget): SalaryVsTarget {
  if (target.salaryMin == null) return "unknown";

  const stated = job.salaryMax ?? job.salaryMin;
  if (stated == null) return "unknown";

  // Currencies are compared, never converted: a made-up rate would be
  // indistinguishable from a real comparison in the output.
  const jobCurrency = (job.salaryCurrency ?? "").trim().toUpperCase();
  if (jobCurrency === "" || jobCurrency !== target.salaryCurrency.trim().toUpperCase())
    return "unknown";

  const jobAnnual = toAnnual(stated, job.salaryPeriod);
  const targetAnnual = toAnnual(target.salaryMin, target.salaryPeriod);
  if (jobAnnual == null || targetAnnual == null) return "unknown";

  // A band around the floor, so a figure a rounding away does not read as a
  // rejection.
  const slack = targetAnnual * 0.02;
  if (jobAnnual > targetAnnual + slack) return "above";
  if (jobAnnual >= targetAnnual - slack) return "within";
  return "below";
}

/**
 * Whether a posting marked remote is actually open to you.
 *
 * "Remote (US only)" is the common case, and it is not remote if you are not
 * in the US — so a restriction is reported rather than folded into "remote".
 */
export function remoteReality(job: {
  remote: boolean | null;
  remoteRestriction: string | null;
}): RemoteReality {
  if (job.remote === null) return "unstated";
  if (!job.remote) return "hybrid-or-onsite";
  const restriction = (job.remoteRestriction ?? "").trim();
  return restriction === "" ? "remote" : "restricted";
}

/** A short phrase for the review screen. */
export function describeSalary(job: JobPay, verdict: SalaryVsTarget): string {
  const state = salaryState(job);
  if (state === "absent") return "pay not stated";
  const currency = job.salaryCurrency ?? "";
  const low = job.salaryMin?.toLocaleString() ?? "";
  const high = job.salaryMax?.toLocaleString() ?? "";
  const figure = state === "range" ? `${low}–${high}` : low || high;
  const period = job.salaryPeriod && job.salaryPeriod !== "annual" ? `/${job.salaryPeriod}` : "";
  const against =
    verdict === "unknown" ? "" : verdict === "below" ? " (below target)" : ` (${verdict} target)`;
  return `${currency} ${figure}${period}${against}`.trim();
}
