-- Fork (mouriya-s-lab/mailflow#14): accept Jev verdicts as a training source.
--
-- Training records come from explicit user marks ('manual'). Jev's high-confidence spam/ham
-- verdicts are the one automatic source allowed in, to give a new user's model its cold start;
-- they are written only through spamTraining.recordJevSpamVerdict.
--
-- One Jev record per message per account: the partial unique index is what that write's
-- ON CONFLICT names, so a repeated verdict for the same message is a no-op. Different accounts
-- that received the same Message-ID keep their own records. Manual and the older auto sources
-- stay outside the index, so their inserts behave as before.
--
-- No existing row is changed: every current source value is still allowed.

ALTER TABLE spam_training_log DROP CONSTRAINT spam_training_log_source_check;
ALTER TABLE spam_training_log ADD CONSTRAINT spam_training_log_source_check
  CHECK (source IN ('manual', 'auto_sa', 'auto_ml', 'auto_combined', 'jev'));

CREATE UNIQUE INDEX spam_training_log_jev_message_uniq
  ON spam_training_log (user_id, account_id, message_id_header)
  WHERE source = 'jev' AND message_id_header IS NOT NULL;
