-- v3 — record where a job's skills came from.
--
-- The deterministic scanner and the AI extractor both write job_skills, and the
-- AI pass needs to know which rows are already its own so it does not re-spend
-- a call on every posting each run. It also keeps the cheap path visible: rows
-- marked `engine` arrived free from sources like Foundit.

ALTER TABLE job_skills ADD COLUMN source TEXT NOT NULL DEFAULT 'scan'
  CHECK (source IN ('engine', 'scan', 'ai'));

CREATE INDEX IF NOT EXISTS idx_job_skills_source ON job_skills(source);
