-- History of imports from the automotive scraper (one row per attempt).
CREATE TABLE IF NOT EXISTS scraper_imports (
  id SERIAL PRIMARY KEY,
  record_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  title TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'skip')),
  status TEXT NOT NULL CHECK (status IN ('done', 'failed', 'awaiting_confirmation')),
  cms_entity TEXT,
  cms_id TEXT,
  diff JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scraper_imports_record_idx ON scraper_imports (record_id);
CREATE INDEX IF NOT EXISTS scraper_imports_status_idx ON scraper_imports (status);
