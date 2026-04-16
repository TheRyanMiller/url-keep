ALTER TABLE bookmarks ADD COLUMN bucket TEXT
  CHECK (bucket IN ('reading', 'videos'));

CREATE INDEX IF NOT EXISTS idx_bookmarks_user_bucket_created
  ON bookmarks(user_id, bucket, created_at DESC, id DESC);
