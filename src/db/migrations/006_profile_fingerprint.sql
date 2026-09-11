-- v6 — record which profile a ranking was computed against.
--
-- Matches and scores are derived from your skill profile, so replacing your
-- résumé invalidates every one of them. Nothing recorded which profile was
-- used, so a dashboard could report seven thousand rankings without being able
-- to say that all of them predated the CV they claimed to reflect.
--
-- Existing rows are left NULL rather than stamped with the current profile.
-- They were computed against something, but nobody knows what, and guessing
-- "current" would recreate exactly the silence this column exists to break.

ALTER TABLE matches ADD COLUMN profile_fingerprint TEXT;
ALTER TABLE scores  ADD COLUMN profile_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_matches_fingerprint ON matches(profile_fingerprint);

-- Company shape: a product company and a staffing agency advertise the same
-- titles and are not the same job. Filled in by `jobscout classify`; NULL means
-- not yet looked at, which is different from "unknown after looking".
ALTER TABLE jobs ADD COLUMN company_type TEXT
  CHECK (company_type IS NULL OR company_type IN
    ('product', 'service', 'consultancy', 'staffing', 'agency', 'nonprofit', 'unknown'));

CREATE INDEX IF NOT EXISTS idx_jobs_company_type ON jobs(company_type);
