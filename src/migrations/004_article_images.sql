-- A news article carries the picture that belongs to its own story, saved on our server
-- with the source named as the credit. Leads remember the picture their feed offered.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS image_src TEXT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS image_w INT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS image_h INT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS image_alt TEXT NOT NULL DEFAULT '';
ALTER TABLE articles ADD COLUMN IF NOT EXISTS image_credit TEXT NOT NULL DEFAULT '';
ALTER TABLE news_leads ADD COLUMN IF NOT EXISTS image_url TEXT;
