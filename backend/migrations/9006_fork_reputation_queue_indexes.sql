-- no-transaction
-- Fork: reputation status polling and backfill share the work-queue queries.
-- Count by account and origin before grouping by state; unlike Jev, these plugins
-- do not list terminal rows by id. Ready reads need only pending/retry rows.
-- Rebuild on retry so an interrupted concurrent build cannot leave an invalid index.
DROP INDEX CONCURRENTLY IF EXISTS messages_tag_rdap_queue_count;
CREATE INDEX CONCURRENTLY messages_tag_rdap_queue_count
  ON messages (account_id,
               (plugin_annotations -> 'tag-rdap' -> 'queue' ->> 'origin'),
               (plugin_annotations -> 'tag-rdap' -> 'queue' ->> 'state'))
  WHERE (plugin_annotations -> 'tag-rdap' -> 'queue' ->> 'origin') IS NOT NULL;
DROP INDEX CONCURRENTLY IF EXISTS messages_tag_rdap_queue_ready;
CREATE INDEX CONCURRENTLY messages_tag_rdap_queue_ready
  ON messages (account_id, id)
  WHERE (plugin_annotations -> 'tag-rdap' -> 'queue' ->> 'state') IN ('pending', 'retry');

DROP INDEX CONCURRENTLY IF EXISTS messages_tag_spamhaus_queue_count;
CREATE INDEX CONCURRENTLY messages_tag_spamhaus_queue_count
  ON messages (account_id,
               (plugin_annotations -> 'tag-spamhaus' -> 'queue' ->> 'origin'),
               (plugin_annotations -> 'tag-spamhaus' -> 'queue' ->> 'state'))
  WHERE (plugin_annotations -> 'tag-spamhaus' -> 'queue' ->> 'origin') IS NOT NULL;
DROP INDEX CONCURRENTLY IF EXISTS messages_tag_spamhaus_queue_ready;
CREATE INDEX CONCURRENTLY messages_tag_spamhaus_queue_ready
  ON messages (account_id, id)
  WHERE (plugin_annotations -> 'tag-spamhaus' -> 'queue' ->> 'state') IN ('pending', 'retry');

DROP INDEX CONCURRENTLY IF EXISTS messages_tag_urlhaus_queue_count;
CREATE INDEX CONCURRENTLY messages_tag_urlhaus_queue_count
  ON messages (account_id,
               (plugin_annotations -> 'tag-urlhaus' -> 'queue' ->> 'origin'),
               (plugin_annotations -> 'tag-urlhaus' -> 'queue' ->> 'state'))
  WHERE (plugin_annotations -> 'tag-urlhaus' -> 'queue' ->> 'origin') IS NOT NULL;
DROP INDEX CONCURRENTLY IF EXISTS messages_tag_urlhaus_queue_ready;
CREATE INDEX CONCURRENTLY messages_tag_urlhaus_queue_ready
  ON messages (account_id, id)
  WHERE (plugin_annotations -> 'tag-urlhaus' -> 'queue' ->> 'state') IN ('pending', 'retry');

DROP INDEX CONCURRENTLY IF EXISTS messages_tag_safebrowsing_queue_count;
CREATE INDEX CONCURRENTLY messages_tag_safebrowsing_queue_count
  ON messages (account_id,
               (plugin_annotations -> 'tag-safebrowsing' -> 'queue' ->> 'origin'),
               (plugin_annotations -> 'tag-safebrowsing' -> 'queue' ->> 'state'))
  WHERE (plugin_annotations -> 'tag-safebrowsing' -> 'queue' ->> 'origin') IS NOT NULL;
DROP INDEX CONCURRENTLY IF EXISTS messages_tag_safebrowsing_queue_ready;
CREATE INDEX CONCURRENTLY messages_tag_safebrowsing_queue_ready
  ON messages (account_id, id)
  WHERE (plugin_annotations -> 'tag-safebrowsing' -> 'queue' ->> 'state') IN ('pending', 'retry');
