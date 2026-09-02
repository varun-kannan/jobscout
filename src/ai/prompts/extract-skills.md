Read the job posting on stdin and list the skills it asks for.

Split them by how the posting frames them:
- `required` — stated as necessary. Headings like "Requirements", "Must have",
  "What you bring", "Qualifications".
- `preferred` — stated as optional. "Nice to have", "Bonus", "A plus",
  "Familiarity with", "Ideally".

Rules:
- Name technologies, domains and practices — "PostgreSQL", "payments",
  "distributed systems". Not soft skills, not "excellent communication".
- Use the name the posting uses. Normalisation happens afterwards.
- Resolve paraphrase to the thing meant: "experience with event streaming
  platforms" is Kafka; "container orchestration" is Kubernetes. This is the main
  reason you are being asked rather than a keyword scan.
- If the posting genuinely lists no skills, return two empty arrays. Do not
  invent plausible ones for the job title.
