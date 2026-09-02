-- v1 — the base schema.
-- Applied only to databases that have never been migrated.

-- jobscout schema v1
--
-- Two ideas shape this file:
--   1. Triage status and application status are separate tracks. Rejecting a
--      job must never touch application history, and an application's progress
--      must never rewrite why a job was approved.
--   2. `matches` stores the counts, not just the composite score, so the
--      ranking can always show its working and be re-sorted without recompute.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  id                    TEXT PRIMARY KEY,
  engine                TEXT NOT NULL,
  native_id             TEXT,
  company               TEXT NOT NULL DEFAULT '',
  title                 TEXT NOT NULL DEFAULT '',
  location              TEXT NOT NULL DEFAULT '',
  remote                INTEGER,               -- 1 true, 0 false, NULL unknown
  remote_restriction    TEXT,                  -- "US only", "EU timezones", …
  apply_url             TEXT NOT NULL DEFAULT '',
  description           TEXT NOT NULL DEFAULT '',
  description_complete  INTEGER NOT NULL DEFAULT 0,
  salary_min            REAL,
  salary_max            REAL,
  salary_currency       TEXT,
  salary_period         TEXT,
  seniority             TEXT,
  employment_type       TEXT,
  posted_at             TEXT,
  first_seen            TEXT NOT NULL,
  last_seen             TEXT NOT NULL,
  raw                   TEXT,                  -- provider payload as JSON
  canonical_id          TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  review_status         TEXT NOT NULL DEFAULT 'new'
                          CHECK (review_status IN
                            ('new','scored','drafted','approved','rejected','auto_skipped'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_engine     ON jobs(engine);
CREATE INDEX IF NOT EXISTS idx_jobs_status     ON jobs(review_status);
CREATE INDEX IF NOT EXISTS idx_jobs_company    ON jobs(company);
CREATE INDEX IF NOT EXISTS idx_jobs_canonical  ON jobs(canonical_id);
CREATE INDEX IF NOT EXISTS idx_jobs_first_seen ON jobs(first_seen);

-- Your skills, extracted from the résumé and editable afterwards.
-- `pinned` marks a row you corrected by hand so re-extraction leaves it alone.
CREATE TABLE IF NOT EXISTS profile_skills (
  skill      TEXT PRIMARY KEY,           -- canonical slug
  label      TEXT NOT NULL,              -- display form
  category   TEXT NOT NULL DEFAULT 'other',
  years      REAL,
  level      TEXT NOT NULL DEFAULT 'working'
               CHECK (level IN ('exposure','working','strong','expert')),
  evidence   TEXT,                       -- the résumé line that proves it
  source     TEXT NOT NULL DEFAULT 'resume',
  pinned     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_skills (
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  skill       TEXT NOT NULL,
  label       TEXT NOT NULL,
  requirement TEXT NOT NULL DEFAULT 'required'
                CHECK (requirement IN ('required','preferred')),
  PRIMARY KEY (job_id, skill)
);

CREATE INDEX IF NOT EXISTS idx_job_skills_skill ON job_skills(skill);

-- "psql" -> "postgresql". Ships with a starter vocabulary and grows.
CREATE TABLE IF NOT EXISTS skill_aliases (
  alias     TEXT PRIMARY KEY,
  canonical TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_aliases_canonical ON skill_aliases(canonical);

-- The table the job list is sorted by.
CREATE TABLE IF NOT EXISTS matches (
  job_id             TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  matched_required   INTEGER NOT NULL DEFAULT 0,
  total_required     INTEGER NOT NULL DEFAULT 0,
  matched_preferred  INTEGER NOT NULL DEFAULT 0,
  total_preferred    INTEGER NOT NULL DEFAULT 0,
  coverage           REAL NOT NULL DEFAULT 0,
  match_score        REAL NOT NULL DEFAULT 0,
  matched            TEXT NOT NULL DEFAULT '[]',  -- JSON array of skill slugs
  missing            TEXT NOT NULL DEFAULT '[]',
  bonus              TEXT NOT NULL DEFAULT '[]',
  matched_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_score ON matches(match_score DESC);

-- The AI's second opinion. Never the ranker.
CREATE TABLE IF NOT EXISTS scores (
  job_id    TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  ai_score  INTEGER CHECK (ai_score BETWEEN 1 AND 5),
  reason    TEXT,
  concerns  TEXT,                        -- JSON array
  model     TEXT,
  scored_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  job_id         TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'prepared'
                   CHECK (status IN
                     ('prepared','submitted','responded','interviewing','offer','closed','ghosted')),
  prepared_at    TEXT,
  submitted_at   TEXT,
  last_status_at TEXT NOT NULL,
  note           TEXT
);

CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);

-- Company boards to poll, found by board discovery and verified before saving.
CREATE TABLE IF NOT EXISTS boards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company     TEXT NOT NULL,
  ats         TEXT NOT NULL,
  token       TEXT NOT NULL,
  verified_at TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (ats, token)
);

CREATE INDEX IF NOT EXISTS idx_boards_active ON boards(active);

-- Why this exists: in the previous system four of six configured sources
-- silently returned nothing, and there was no way to tell a broken source
-- from an empty one. Now every run records its own outcome.
CREATE TABLE IF NOT EXISTS engine_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  engine      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','ok','empty','error','rate_limited','skipped')),
  fetched     INTEGER NOT NULL DEFAULT 0,
  inserted    INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_engine_runs_engine ON engine_runs(engine, started_at DESC);

-- Confirmed screening answers, so the same question is never drafted twice.
CREATE TABLE IF NOT EXISTS answers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  question     TEXT NOT NULL UNIQUE,
  answer       TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  times_used   INTEGER NOT NULL DEFAULT 0
);
