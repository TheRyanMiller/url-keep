ALTER TABLE bookmarks ADD COLUMN share_id TEXT;
ALTER TABLE bookmarks ADD COLUMN share_enabled_at TEXT;
ALTER TABLE bookmarks ADD COLUMN share_revoked_at TEXT;
ALTER TABLE bookmarks ADD COLUMN share_view_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookmarks ADD COLUMN share_last_accessed_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookmarks_share_id
  ON bookmarks(share_id);
