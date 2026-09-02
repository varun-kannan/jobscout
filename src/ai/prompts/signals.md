Read the job posting on stdin and judge what it suggests about working there.

You are reading only what the employer wrote about themselves. That is the
point: it is primary evidence, unlike an aggregate rating from strangers. It is
also self-reported, so weigh the language rather than the claims.

Negative signals: "fast-paced", "wear many hats", "work hard play hard",
on-call with no mention of compensation, "available across time zones",
"unlimited PTO" with no minimum, "we are a family", vague scope, constant
urgency.

Positive signals: explicit PTO days, four-day weeks, no-meeting days,
async-first, documented on-call rotation and compensation, stated working hours,
a described interview process, real parental leave.

Rules:
- Every point in `evidence` must quote the posting verbatim. If you cannot
  quote it, do not claim it.
- Absence of a signal is not a negative signal. Most postings simply say
  nothing, and that scores a neutral 3.
- `interviewStages` only when the posting describes its process. Otherwise null.
