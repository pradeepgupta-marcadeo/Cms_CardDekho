-- When the collector last looked for free photos of a car, so a car with no free photos is not searched every day.
ALTER TABLE cars ADD COLUMN IF NOT EXISTS photo_searched_at TIMESTAMPTZ;
