-- v7 — the crawl log.
--
-- Every fetch is recorded so a second run is cheap: a page we saw an hour ago
-- and that carries an ETag is re-validated rather than re-downloaded, and a
-- host that told us not to come back is not asked again.
--
-- Keyed by URL rather than by job, because the same page can back several
-- postings and because the crawler also fetches things that are not postings
-- at all — robots.txt, careers pages, company sites.

CREATE TABLE IF NOT EXISTS crawl_log (
  url            TEXT PRIMARY KEY,
  host           TEXT NOT NULL,
  -- ok | not_modified | disallowed | blocked | not_found | gone | error
  outcome        TEXT NOT NULL,
  status         INTEGER,
  -- Validators, so the next visit can ask "has this changed?" instead of
  -- downloading it again.
  etag           TEXT,
  last_modified  TEXT,
  -- Hash of the body, so a change can be detected even without validators.
  content_hash   TEXT,
  content_length INTEGER,
  fetched_at     TEXT NOT NULL,
  error          TEXT
);

CREATE INDEX IF NOT EXISTS idx_crawl_log_host    ON crawl_log(host, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_crawl_log_fetched ON crawl_log(fetched_at DESC);

-- robots.txt, cached per host with the time we read it. A host is re-checked
-- once a day rather than once per request.
CREATE TABLE IF NOT EXISTS robots_cache (
  host       TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  -- Whether the file was actually readable; a 404 means "no rules", which is
  -- different from "we could not tell".
  reachable  INTEGER NOT NULL DEFAULT 1
);
