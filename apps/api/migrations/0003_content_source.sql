ALTER TABLE article_content ADD COLUMN content_source TEXT DEFAULT NULL
  CHECK (content_source IN ('client', 'server'));
