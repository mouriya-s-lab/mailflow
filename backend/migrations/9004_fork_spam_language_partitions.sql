-- Fork (mouriya-s-lab/mailflow#15): one anti-spam model per user and language.
--
-- Training records gain the language that picks their model partition and the version of the
-- tokenizer that made their token_counts. Records written before this migration get NULL in
-- both; the next retrain of their user computes the language and the tokens from the stored
-- subject and body and writes both back, so no existing record is rewritten here.
--
-- spam_models becomes one row per (user_id, language). Its existing rows are deleted: each is a
-- language-blind model built with the old tokenizer, so it fits no partition, and every count in
-- it is derived from spam_training_log, which keeps all records. A user's next retrain builds the
-- partitions: run a full retrain right after this migration (admin "retrain now"), otherwise the
-- hourly scheduler reaches each user within a day, and until then classification is rules-only
-- and the status shows no partitions.
--
-- decay_threshold_days was the one setting on that row. It is per user, not per partition, so
-- it moves to users.preferences.spamDecayThresholdDays (next to spamEnabled and
-- spam_thresholds) before the rows go.

ALTER TABLE spam_training_log
  ADD COLUMN language TEXT,
  ADD COLUMN tokenizer_version INTEGER;

COMMENT ON COLUMN spam_training_log.language IS
  'Model partition of this record: the BCP 47 tag the message signals resolve from its subject and Content-Language. NULL until a retrain re-tokenizes a record written before the column existed.';
COMMENT ON COLUMN spam_training_log.tokenizer_version IS
  'spamTokenizer.TOKENIZER_VERSION that produced token_counts. A retrain re-tokenizes every record of another version (NULL included) and writes language, token_counts and this back.';

UPDATE users u
   SET preferences = COALESCE(u.preferences, '{}'::jsonb)
       || jsonb_build_object('spamDecayThresholdDays', m.decay_threshold_days)
  FROM spam_models m
 WHERE m.user_id = u.id;

DELETE FROM spam_models;

ALTER TABLE spam_models DROP CONSTRAINT spam_models_pkey;
ALTER TABLE spam_models DROP COLUMN decay_threshold_days;
ALTER TABLE spam_models ADD COLUMN language TEXT NOT NULL;
ALTER TABLE spam_models ADD PRIMARY KEY (user_id, language);

COMMENT ON TABLE spam_models IS
  'Per-user, per-language Naive Bayes spam classifier state: one row per user and model partition. Vocabulary is JSONB; counts are running totals updated incrementally on user feedback and rebuilt by the retrain.';
COMMENT ON COLUMN spam_models.language IS
  'Model partition: the BCP 47 language tag of the training records it was built from (spam_training_log.language).';
