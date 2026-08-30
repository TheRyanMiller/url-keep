CREATE TRIGGER IF NOT EXISTS revoke_share_on_article_insert
AFTER INSERT ON article_content
BEGIN
  UPDATE bookmarks
  SET
    share_id = NULL,
    share_enabled_at = NULL,
    share_revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    share_view_count = 0,
    share_last_accessed_at = NULL
  WHERE id = NEW.bookmark_id AND user_id = NEW.user_id AND share_id IS NOT NULL;
END;

CREATE TRIGGER IF NOT EXISTS revoke_share_on_article_update
AFTER UPDATE ON article_content
WHEN
  OLD.id IS NOT NEW.id OR
  OLD.content_html IS NOT NEW.content_html OR
  OLD.word_count IS NOT NEW.word_count OR
  OLD.author IS NOT NEW.author OR
  OLD.published_date IS NOT NEW.published_date OR
  OLD.extraction_status IS NOT NEW.extraction_status OR
  OLD.extraction_error IS NOT NEW.extraction_error OR
  OLD.extracted_at IS NOT NEW.extracted_at OR
  OLD.content_source IS NOT NEW.content_source
BEGIN
  UPDATE bookmarks
  SET
    share_id = NULL,
    share_enabled_at = NULL,
    share_revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    share_view_count = 0,
    share_last_accessed_at = NULL
  WHERE id = NEW.bookmark_id AND user_id = NEW.user_id AND share_id IS NOT NULL;
END;

CREATE TRIGGER IF NOT EXISTS revoke_share_on_article_delete
AFTER DELETE ON article_content
BEGIN
  UPDATE bookmarks
  SET
    share_id = NULL,
    share_enabled_at = NULL,
    share_revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    share_view_count = 0,
    share_last_accessed_at = NULL
  WHERE id = OLD.bookmark_id AND user_id = OLD.user_id AND share_id IS NOT NULL;
END;
