Read the job posting on stdin and extract its structured facts.

Rules:
- Report only what the posting states. Never infer from the company name or your
  own knowledge of the employer.
- Use `unknown` and `null` freely. A wrong value is far worse than a missing one.
- For `remote`, read the whole posting before deciding. A title saying "Remote"
  with a body saying "must reside in the United States" is `remote-restricted`,
  and `remoteRestriction` records the limit. This distinction is the single most
  useful thing you produce.
- Salary must be a figure the posting names. Do not estimate, and do not convert
  currencies. If a range is given per month, set `salaryPeriod` to `monthly`
  rather than annualising it.
