PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX idx_access_tokens_user_active
  ON access_tokens(user_id, revoked_at, created_at DESC);

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('reading', 'videos')),
  title TEXT NOT NULL,
  title_source TEXT NOT NULL CHECK (title_source IN ('fallback', 'client', 'user')),
  image_url TEXT,
  site_name TEXT,
  saved_via TEXT NOT NULL
    CHECK (saved_via IN ('web', 'mobile_web', 'extension', 'ios_shortcut')),
  share_id TEXT UNIQUE,
  share_enabled_at TEXT,
  share_revoked_at TEXT,
  share_view_count INTEGER NOT NULL DEFAULT 0 CHECK (share_view_count >= 0),
  share_last_accessed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, normalized_url)
);

CREATE INDEX idx_bookmarks_user_created
  ON bookmarks(user_id, created_at DESC, id DESC);

CREATE INDEX idx_bookmarks_user_bucket_created
  ON bookmarks(user_id, bucket, created_at DESC, id DESC);

CREATE TABLE article_content (
  id TEXT PRIMARY KEY,
  bookmark_id TEXT NOT NULL UNIQUE REFERENCES bookmarks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content_html TEXT,
  word_count INTEGER NOT NULL DEFAULT 0 CHECK (word_count >= 0),
  author TEXT,
  published_date TEXT,
  extraction_status TEXT NOT NULL
    CHECK (extraction_status IN ('pending', 'complete', 'failed', 'skipped')),
  extraction_error TEXT,
  extracted_at TEXT,
  content_source TEXT CHECK (content_source IN ('client', 'server')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_article_content_user_status
  ON article_content(user_id, extraction_status);

CREATE TABLE offline_sync_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0)
);

CREATE TABLE narrations (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL UNIQUE REFERENCES article_content(id) ON DELETE CASCADE,
  service_job_id TEXT NOT NULL UNIQUE,
  text_sha256 TEXT NOT NULL
    CHECK (length(text_sha256) = 64 AND text_sha256 NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'publishing', 'ready', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count IN (0, 1)),
  publish_started_at TEXT,
  engine_fingerprint TEXT,
  error_code TEXT CHECK (
    error_code IS NULL OR error_code IN (
      'source_mismatch', 'invalid_service_output', 'input_mismatch',
      'encoder_failed', 'storage_full', 'file_too_large', 'generation_failed',
      'storage_io', 'worker_interrupted', 'audio_missing'
    )
  ),
  audio_key TEXT NOT NULL UNIQUE,
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
    (status = 'publishing' AND publish_started_at IS NOT NULL)
    OR (status != 'publishing' AND publish_started_at IS NULL)
  ),
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
    (status IN ('pending', 'publishing') AND finished_at IS NULL)
    OR (status IN ('ready', 'failed') AND finished_at IS NOT NULL)
  )
);

CREATE INDEX idx_narrations_status_updated
  ON narrations(status, updated_at);

CREATE INDEX idx_narrations_status_publish_started
  ON narrations(status, publish_started_at);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token_id TEXT NOT NULL UNIQUE REFERENCES access_tokens(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE narration_notifications (
  narration_id TEXT NOT NULL REFERENCES narrations(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (narration_id, subscription_id)
);

CREATE INDEX idx_narration_notifications_due
  ON narration_notifications(next_attempt_at);

CREATE TABLE narration_cleanup_jobs (
  service_job_id TEXT PRIMARY KEY,
  audio_key TEXT NOT NULL UNIQUE,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_narration_cleanup_jobs_due
  ON narration_cleanup_jobs(next_attempt_at);

CREATE TRIGGER offline_revision_bookmark_insert
AFTER INSERT ON bookmarks
BEGIN
  INSERT INTO offline_sync_state (user_id, revision) VALUES (NEW.user_id, 1)
  ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_revision_bookmark_delete
AFTER DELETE ON bookmarks
BEGIN
  INSERT INTO offline_sync_state (user_id, revision) VALUES (OLD.user_id, 1)
  ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_revision_bookmark_update
AFTER UPDATE ON bookmarks
WHEN
  OLD.url IS NOT NEW.url OR OLD.normalized_url IS NOT NEW.normalized_url OR
  OLD.bucket IS NOT NEW.bucket OR OLD.title IS NOT NEW.title OR
  OLD.title_source IS NOT NEW.title_source OR OLD.image_url IS NOT NEW.image_url OR
  OLD.site_name IS NOT NEW.site_name OR OLD.saved_via IS NOT NEW.saved_via OR
  OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at
BEGIN
  INSERT INTO offline_sync_state (user_id, revision) VALUES (NEW.user_id, 1)
  ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_revision_article_insert
AFTER INSERT ON article_content
BEGIN
  INSERT INTO offline_sync_state (user_id, revision) VALUES (NEW.user_id, 1)
  ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_revision_article_delete
AFTER DELETE ON article_content
BEGIN
  INSERT INTO offline_sync_state (user_id, revision) VALUES (OLD.user_id, 1)
  ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_revision_article_update
AFTER UPDATE ON article_content
WHEN
  OLD.content_html IS NOT NEW.content_html OR OLD.title IS NOT NEW.title OR
  OLD.word_count IS NOT NEW.word_count OR OLD.author IS NOT NEW.author OR
  OLD.published_date IS NOT NEW.published_date OR
  OLD.extraction_status IS NOT NEW.extraction_status OR
  OLD.extraction_error IS NOT NEW.extraction_error OR
  OLD.extracted_at IS NOT NEW.extracted_at OR
  OLD.content_source IS NOT NEW.content_source OR OLD.updated_at IS NOT NEW.updated_at
BEGIN
  INSERT INTO offline_sync_state (user_id, revision) VALUES (NEW.user_id, 1)
  ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER revoke_share_on_article_insert
AFTER INSERT ON article_content
BEGIN
  UPDATE bookmarks
  SET share_id = NULL, share_enabled_at = NULL,
      share_revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      share_view_count = 0, share_last_accessed_at = NULL
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
      share_revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      share_view_count = 0, share_last_accessed_at = NULL
  WHERE id = NEW.bookmark_id AND user_id = NEW.user_id AND share_id IS NOT NULL;
END;

CREATE TRIGGER revoke_share_on_article_delete
AFTER DELETE ON article_content
BEGIN
  UPDATE bookmarks
  SET share_id = NULL, share_enabled_at = NULL,
      share_revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      share_view_count = 0, share_last_accessed_at = NULL
  WHERE id = OLD.bookmark_id AND user_id = OLD.user_id AND share_id IS NOT NULL;
END;

CREATE TRIGGER enqueue_narration_cleanup_before_delete
BEFORE DELETE ON narrations
BEGIN
  INSERT INTO narration_cleanup_jobs(
    service_job_id, audio_key, attempt_count, next_attempt_at, created_at
  )
  VALUES (OLD.service_job_id, OLD.audio_key, 0,
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

CREATE TRIGGER delete_subscription_on_token_revoke
AFTER UPDATE OF revoked_at ON access_tokens
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  DELETE FROM push_subscriptions WHERE access_token_id = NEW.id;
END;
