PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS article_content (
  id TEXT PRIMARY KEY,
  bookmark_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  content_html TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  author TEXT,
  published_date TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending', 'complete', 'failed', 'skipped')),
  extraction_error TEXT,
  extracted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_article_content_user_status
  ON article_content(user_id, extraction_status);
