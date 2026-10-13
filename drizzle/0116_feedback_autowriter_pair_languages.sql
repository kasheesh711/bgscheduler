-- Owner overrides of the autowriter's tutor–student pair language labels (English / Bilingual / Thai), keyed by the
-- Wise class and the roster tutor key. Display only in this release: routing does not read the table yet; clearing an
-- override deletes its row.
CREATE TABLE feedback_autowriter_pair_languages (
  wise_class_id text NOT NULL,
  tutor_key text NOT NULL,
  language text NOT NULL,
  set_by text NOT NULL,
  set_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT feedback_autowriter_pair_languages_wise_class_id_tutor_key_pk PRIMARY KEY (wise_class_id, tutor_key),
  CONSTRAINT feedback_autowriter_pair_languages_language_check CHECK (language IN ('english', 'bilingual', 'thai'))
);
