-- Fork (mouriya-s-lab/mailflow#10): keep a whitelisted set of each message's raw headers.
--
-- Authentication-Results, Content-Language, the original From/Reply-To and similar headers
-- exist only while a message is being ingested; messages keeps none of them. Later signal
-- extraction and spam training need them, so they are stored here, keyed by the message
-- row: a row deleted or replaced by a new id takes its record with it, and a read of a row
-- without a record fetches the headers from the server again.
--
-- source records how the headers were obtained: 'ingest' at sync/backfill time, or
-- 'imap_fetch' when a message ingested before this table existed was read on demand.
--
-- Creates a new table only; no existing table or row is changed.

CREATE TABLE fork_message_headers (
  message_id  UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  headers     JSONB NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('ingest', 'imap_fetch')),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
