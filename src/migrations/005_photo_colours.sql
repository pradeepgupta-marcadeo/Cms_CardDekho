-- A car photo can belong to one of the car's colours (the name as written in the car's colour list).
-- NULL means "not colour-specific or unknown". colour_by records who decided: text, pixels or editor.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS colour TEXT;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS colour_by TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS photos_colour_idx ON photos (car_id, colour);
