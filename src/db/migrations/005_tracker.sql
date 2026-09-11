-- v5 — the application tracker.
--
-- Two statuses were missing from the lifecycle, and both matter.
--
-- `viewed` is the step before any commitment: you opened a posting and read it.
-- Without it there is no way to tell "not looked at yet" from "looked at and
-- not acted on", which is most of what a long search actually consists of.
--
-- `rejected` was being folded into `closed`. They are different outcomes — one
-- is their decision, the other is yours or the calendar's — and a tracker that
-- cannot tell them apart cannot answer "how many rejections", which is the
-- number people actually want.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. Rows are
-- copied first and the old table dropped only after, inside the transaction the
-- migration runner already provides.

CREATE TABLE applications_new (
  job_id         TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'viewed'
                   CHECK (status IN
                     ('viewed','prepared','submitted','responded','interviewing',
                      'offer','rejected','closed','ghosted')),
  prepared_at    TEXT,
  submitted_at   TEXT,
  last_status_at TEXT NOT NULL,
  note           TEXT
);

INSERT INTO applications_new (job_id, status, prepared_at, submitted_at, last_status_at, note)
  SELECT job_id, status, prepared_at, submitted_at, last_status_at, note FROM applications;

DROP TABLE applications;
ALTER TABLE applications_new RENAME TO applications;

-- The tracker lists by recency within a status, and both are always filtered.
CREATE INDEX IF NOT EXISTS idx_applications_status
  ON applications(status, last_status_at DESC);
