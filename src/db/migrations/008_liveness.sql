-- v8 — whether a posting is still open.
--
-- Kept separate from `review_status`, which is your decision about a job.
-- Whether the employer still wants applicants is their decision, and the two
-- must not overwrite each other: a job you approved that then closes is still
-- approved, and should say so alongside being closed.
--
-- NULL means never checked, which is different from "checked and unreachable".
ALTER TABLE jobs ADD COLUMN liveness TEXT
  CHECK (liveness IS NULL OR liveness IN ('open','closed','gone','unreachable','unknown'));
ALTER TABLE jobs ADD COLUMN liveness_checked_at TEXT;
ALTER TABLE jobs ADD COLUMN liveness_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_liveness ON jobs(liveness, liveness_checked_at);
