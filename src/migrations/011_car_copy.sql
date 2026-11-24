-- AI-written copy for each car page: the summary and verdict (pros, cons, guide and FAQs keep their own columns),
-- and what it was written from (research hash, keyword, model), so a car is rewritten only when its data changes.
ALTER TABLE cars ADD COLUMN IF NOT EXISTS copy JSONB;
