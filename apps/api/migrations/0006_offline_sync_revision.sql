PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS offline_sync_state (
  user_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO offline_sync_state (user_id, revision)
SELECT DISTINCT user_id, 1 FROM bookmarks
WHERE 1
ON CONFLICT(user_id) DO NOTHING;

CREATE TRIGGER IF NOT EXISTS offline_revision_bookmark_insert
AFTER INSERT ON bookmarks
BEGIN
  INSERT INTO offline_sync_state (user_id, revision) VALUES (NEW.user_id, 1)
  ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS offline_revision_bookmark_delete
AFTER DELETE ON bookmarks
BEGIN
  INSERT INTO offline_sync_state (user_id, revision) VALUES (OLD.user_id, 1)
  ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS offline_revision_bookmark_update
AFTER UPDATE ON bookmarks
WHEN
  OLD.url IS NOT NEW.url OR
  OLD.normalized_url IS NOT NEW.normalized_url OR
  OLD.bucket IS NOT NEW.bucket OR
  OLD.title IS NOT NEW.title OR
  OLD.title_source IS NOT NEW.title_source OR
  OLD.image_url IS NOT NEW.image_url OR
  OLD.site_name IS NOT NEW.site_name OR
  OLD.saved_via IS NOT NEW.saved_via OR
  OLD.created_at IS NOT NEW.created_at OR
  OLD.updated_at IS NOT NEW.updated_at
BEGIN
  INSERT INTO offline_sync_state (user_id, revision) VALUES (NEW.user_id, 1)
  ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS offline_revision_article_insert
AFTER INSERT ON article_content
BEGIN
  INSERT INTO offline_sync_state (user_id, revision) VALUES (NEW.user_id, 1)
  ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS offline_revision_article_delete
AFTER DELETE ON article_content
BEGIN
  INSERT INTO offline_sync_state (user_id, revision) VALUES (OLD.user_id, 1)
  ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS offline_revision_article_update
AFTER UPDATE ON article_content
WHEN
  OLD.id IS NOT NEW.id OR
  OLD.bookmark_id IS NOT NEW.bookmark_id OR
  OLD.user_id IS NOT NEW.user_id OR
  OLD.content_html IS NOT NEW.content_html OR
  OLD.word_count IS NOT NEW.word_count OR
  OLD.author IS NOT NEW.author OR
  OLD.published_date IS NOT NEW.published_date OR
  OLD.extraction_status IS NOT NEW.extraction_status OR
  OLD.extraction_error IS NOT NEW.extraction_error OR
  OLD.extracted_at IS NOT NEW.extracted_at OR
  OLD.content_source IS NOT NEW.content_source OR
  OLD.created_at IS NOT NEW.created_at OR
  OLD.updated_at IS NOT NEW.updated_at
BEGIN
  INSERT INTO offline_sync_state (user_id, revision) VALUES (NEW.user_id, 1)
  ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
END;
