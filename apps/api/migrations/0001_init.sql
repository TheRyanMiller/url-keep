PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_access_tokens_user_active
  ON access_tokens(user_id, revoked_at, created_at DESC);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  title TEXT NOT NULL,
  title_source TEXT NOT NULL,
  image_url TEXT,
  site_name TEXT,
  saved_via TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(user_id, normalized_url),
  CHECK (title_source IN ('fallback', 'client', 'user')),
  CHECK (saved_via IN ('web', 'mobile_web', 'extension', 'ios_shortcut'))
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_user_created
  ON bookmarks(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bookmarks_user_normalized_url
  ON bookmarks(user_id, normalized_url);
