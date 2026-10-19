-- no-transaction
-- Jev tab reads span INBOX and the physical folder Jev moved a message to.
-- Without this partial index, date-ordered lists can scan the entire history
-- and counts must parse annotations outside the tab scope. Keep this predicate
-- aligned with jevFolderScope in src/services/categoryTabs.js.
-- Rebuild on retry, including an interrupted concurrent build left invalid.
DROP INDEX CONCURRENTLY IF EXISTS messages_jev_category_tab_scope;
CREATE INDEX CONCURRENTLY messages_jev_category_tab_scope
  ON messages (account_id, date DESC, id)
  WHERE is_deleted = false
    AND (folder = 'INBOX'
      OR (plugin_annotations #>> '{"jev-classify",category,action,effect}' = 'moved'
        AND folder = plugin_annotations #>> '{"jev-classify",category,action,target}'));
