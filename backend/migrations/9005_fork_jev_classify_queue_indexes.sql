-- no-transaction
-- Fork (mouriya-s-lab/mailflow#17): indexes for the jev-classify plugin's work queue.
--
-- The plugin keeps its queue in messages.plugin_annotations -> 'jev-classify' -> 'queue'
-- (fork-features/work-queue). Without an index every queue read scans all of an account's
-- messages. Both indexes are partial on that plugin id, so they hold only the rows the plugin
-- has marked and cost nothing for the rest of the table:
--
--   messages_jev_classify_queue_ready  rows whose queue is pending or retry, for
--                                      listQueuedMessages (the work picked every tick)
--   messages_jev_classify_queue_state  every marked row by state and origin, for countQueued
--                                      (status and backfill completion) and
--                                      listMessagesInQueueState (retry-failed)
-- The queue queries pass the plugin id as a parameter. node-postgres sends unnamed statements,
-- which PostgreSQL plans with the parameter values bound, so the planner sees the literal
-- 'jev-classify' and can match these predicates. countQueued filters on origin and
-- listMessagesInQueueState on state, so the second predicate names both: each query implies
-- one side of the OR. Every marked row has both fields.
--
-- CONCURRENTLY (hence no-transaction) so building them never blocks writes on messages. Each
-- name is dropped first: a crash during CREATE INDEX CONCURRENTLY leaves an invalid index that
-- IF NOT EXISTS would keep forever, so the retry rebuilds it from scratch.
DROP INDEX CONCURRENTLY IF EXISTS messages_jev_classify_queue_ready;
CREATE INDEX CONCURRENTLY messages_jev_classify_queue_ready
  ON messages (account_id, id)
  WHERE (plugin_annotations -> 'jev-classify' -> 'queue' ->> 'state') IN ('pending', 'retry');
DROP INDEX CONCURRENTLY IF EXISTS messages_jev_classify_queue_state;
CREATE INDEX CONCURRENTLY messages_jev_classify_queue_state
  ON messages (account_id,
               (plugin_annotations -> 'jev-classify' -> 'queue' ->> 'state'),
               (plugin_annotations -> 'jev-classify' -> 'queue' ->> 'origin'),
               id)
  WHERE (plugin_annotations -> 'jev-classify' -> 'queue' ->> 'state') IS NOT NULL
     OR (plugin_annotations -> 'jev-classify' -> 'queue' ->> 'origin') IS NOT NULL;
