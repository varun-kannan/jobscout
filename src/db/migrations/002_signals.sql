-- v2 — "is this worth my time?", kept separate from "does it match my skills?".

-- "Is this worth my time?", as distinct from "does it match my skills?".
--
-- Employee-review ratings are deliberately absent: Glassdoor's API returns
-- 410 Gone, and Levels.fyi, Comparably and AmbitionBox all refuse anonymous
-- requests. What remains is scraping sites with active bot detection, which is
-- the same line drawn at Naukri. So these signals come from the posting itself
-- — primary evidence from the employer — plus your own recorded history.
CREATE TABLE IF NOT EXISTS signals (
  job_id           TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,

  -- How the pay figure was obtained. 'absent' is a signal in its own right.
  salary_state     TEXT NOT NULL DEFAULT 'absent'
                     CHECK (salary_state IN ('disclosed','parsed','estimated','absent')),
  salary_vs_target TEXT NOT NULL DEFAULT 'unknown'
                     CHECK (salary_vs_target IN ('above','within','below','unknown')),

  -- 1 poor .. 5 good, read from the language of the posting. Never a rating
  -- from a third party; always accompanied by the lines that justify it.
  wlb_score        INTEGER CHECK (wlb_score BETWEEN 1 AND 5),
  wlb_evidence     TEXT NOT NULL DEFAULT '[]',  -- [{quote, polarity, note}]

  red_flags        TEXT NOT NULL DEFAULT '[]',
  green_flags      TEXT NOT NULL DEFAULT '[]',

  remote_reality   TEXT,        -- 'remote' | 'remote-restricted' | 'hybrid' | 'onsite'
  interview_stages INTEGER,     -- when the posting states its process
  repost_count     INTEGER NOT NULL DEFAULT 0,

  computed_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signals_wlb ON signals(wlb_score);

-- Your own research on a company, recorded once and reused forever. Also where
-- a rating you looked up by hand on Glassdoor lands, so you never look it up twice.
CREATE TABLE IF NOT EXISTS company_notes (
  company     TEXT PRIMARY KEY,
  rating      INTEGER CHECK (rating BETWEEN 1 AND 5),
  note        TEXT,
  avoid       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);
