-- Fork (mouriya-s-lab/mailflow#12): cache of domain and URL reputation lookups.
--
-- One row per (source, subject): source is 'rdap', 'spamhaus_dbl', 'urlhaus' or
-- 'safe_browsing'; subject is a registrable domain, or a canonical URL for Safe Browsing.
-- result is the source's verdict as the reputation module returns it. The rows are a copy
-- of what the outside services said at fetched_at, kept until expires_at and fetched again
-- after it; failed lookups are never stored. Global rather than per user: a verdict is
-- about a domain, not about anyone's mail.
--
-- Creates a new table only; no existing table or row is changed.

CREATE TABLE fork_reputation_cache (
  source     TEXT NOT NULL,
  subject    TEXT NOT NULL,
  result     JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source, subject)
);
