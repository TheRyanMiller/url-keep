PRAGMA foreign_keys = ON;

-- Complete Release A cutover. This file was verified as unapplied remotely
-- before implementation; never edit it after it has been applied.

DROP TRIGGER delete_subscription_on_token_revoke;
DROP TRIGGER revoke_share_on_article_insert;
DROP TRIGGER revoke_share_on_article_update;
DROP TRIGGER revoke_share_on_article_delete;
DROP TRIGGER enqueue_narration_cleanup_before_delete;
DROP TRIGGER offline_revision_narration_ready;
DROP TRIGGER offline_revision_narration_invalidated;

DROP INDEX idx_narration_notifications_due;
DROP INDEX idx_narration_cleanup_jobs_due;
DROP INDEX idx_narrations_status_updated;
DROP INDEX idx_narrations_status_publish_started;

DROP TABLE narration_notifications;
DROP TABLE push_subscriptions;

ALTER TABLE narration_cleanup_jobs RENAME TO narration_cleanup_jobs_old;
ALTER TABLE narrations RENAME TO narrations_old;

CREATE TABLE narrations (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL UNIQUE REFERENCES article_content(id) ON DELETE CASCADE,
  service_job_id TEXT NOT NULL UNIQUE,
  text_sha256 TEXT NOT NULL
    CHECK (length(text_sha256) = 64 AND text_sha256 NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count IN (0, 1)),
  engine_fingerprint TEXT,
  error_code TEXT CHECK (
    error_code IS NULL OR error_code IN (
      'source_mismatch', 'invalid_service_output', 'input_mismatch',
      'encoder_failed', 'storage_full', 'file_too_large', 'generation_failed',
      'storage_io', 'worker_interrupted', 'audio_missing'
    )
  ),
  audio_sha256 TEXT CHECK (
    audio_sha256 IS NULL
    OR (length(audio_sha256) = 64 AND audio_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size > 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK (
    (status = 'ready'
      AND engine_fingerprint IS NOT NULL
      AND error_code IS NULL
      AND audio_sha256 IS NOT NULL
      AND byte_size IS NOT NULL
      AND duration_ms IS NOT NULL
      AND finished_at IS NOT NULL)
    OR
    (status != 'ready'
      AND audio_sha256 IS NULL
      AND byte_size IS NULL
      AND duration_ms IS NULL)
  ),
  CHECK (
    (status = 'failed' AND error_code IS NOT NULL AND finished_at IS NOT NULL)
    OR (status != 'failed' AND error_code IS NULL)
  ),
  CHECK (
    (status = 'pending' AND finished_at IS NULL)
    OR (status IN ('ready', 'failed') AND finished_at IS NOT NULL)
  )
);

CREATE INDEX idx_narrations_status_updated
  ON narrations(status, updated_at);

CREATE TABLE narration_cleanup_jobs (
  service_job_id TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_narration_cleanup_jobs_due
  ON narration_cleanup_jobs(next_attempt_at, service_job_id);

INSERT INTO narrations(
  id, article_id, service_job_id, text_sha256, status, retry_count,
  engine_fingerprint, error_code, audio_sha256,
  byte_size, duration_ms, created_at, updated_at, finished_at
)
SELECT
  id, article_id, service_job_id, text_sha256,
  CASE WHEN status = 'publishing' THEN 'pending' ELSE status END, retry_count,
  engine_fingerprint, error_code, audio_sha256,
  byte_size, duration_ms, created_at, updated_at, finished_at
FROM narrations_old;

INSERT INTO narration_cleanup_jobs(
  service_job_id, attempt_count, next_attempt_at, created_at
)
SELECT service_job_id, attempt_count, next_attempt_at, created_at
FROM narration_cleanup_jobs_old;

DROP TABLE narration_cleanup_jobs_old;
DROP TABLE narrations_old;

ALTER TABLE bookmarks DROP COLUMN share_view_count;
ALTER TABLE bookmarks DROP COLUMN share_last_accessed_at;

CREATE TRIGGER revoke_share_on_article_insert
AFTER INSERT ON article_content
BEGIN
  UPDATE bookmarks
  SET share_id = NULL, share_enabled_at = NULL,
      share_revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.bookmark_id AND user_id = NEW.user_id AND share_id IS NOT NULL;
END;

CREATE TRIGGER revoke_share_on_article_update
AFTER UPDATE ON article_content
WHEN
  OLD.content_html IS NOT NEW.content_html OR OLD.title IS NOT NEW.title OR
  OLD.word_count IS NOT NEW.word_count OR OLD.author IS NOT NEW.author OR
  OLD.published_date IS NOT NEW.published_date OR
  OLD.extraction_status IS NOT NEW.extraction_status OR
  OLD.extraction_error IS NOT NEW.extraction_error OR
  OLD.extracted_at IS NOT NEW.extracted_at OR OLD.content_source IS NOT NEW.content_source
BEGIN
  UPDATE bookmarks
  SET share_id = NULL, share_enabled_at = NULL,
      share_revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.bookmark_id AND user_id = NEW.user_id AND share_id IS NOT NULL;
END;

CREATE TRIGGER revoke_share_on_article_delete
AFTER DELETE ON article_content
BEGIN
  UPDATE bookmarks
  SET share_id = NULL, share_enabled_at = NULL,
      share_revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = OLD.bookmark_id AND user_id = OLD.user_id AND share_id IS NOT NULL;
END;

CREATE TRIGGER enqueue_narration_cleanup_before_delete
BEFORE DELETE ON narrations
BEGIN
  INSERT INTO narration_cleanup_jobs(
    service_job_id, attempt_count, next_attempt_at, created_at
  )
  VALUES (OLD.service_job_id, 0,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(service_job_id) DO NOTHING;
END;

CREATE TRIGGER offline_revision_narration_ready
AFTER UPDATE OF status ON narrations
WHEN OLD.status != 'ready' AND NEW.status = 'ready'
BEGIN
  INSERT INTO offline_sync_state(user_id, revision)
  SELECT ac.user_id, 1 FROM article_content ac WHERE ac.id = NEW.article_id
  ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_revision_narration_invalidated
AFTER UPDATE OF status ON narrations
WHEN OLD.status = 'ready' AND NEW.status != 'ready'
BEGIN
  INSERT INTO offline_sync_state(user_id, revision)
  SELECT ac.user_id, 1 FROM article_content ac WHERE ac.id = NEW.article_id
  ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
END;
