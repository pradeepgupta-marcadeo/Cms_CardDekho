-- 360 views (CarWale studio spins, usually 72 frames, one every 5 degrees) copied into uploads/carwale360/.
-- One row per car and view: closed doors, and open doors where CarWale has one. frames: the local frame addresses in order.
CREATE TABLE IF NOT EXISTS car_spins (
  car_slug TEXT NOT NULL,                 -- CarDekho car slug, e.g. tata/tiago
  kind TEXT NOT NULL,                     -- closed | open
  source_page TEXT,
  colour TEXT,
  version TEXT,
  frames JSONB NOT NULL DEFAULT '[]',
  w INTEGER,
  h INTEGER,
  status TEXT NOT NULL DEFAULT 'done',    -- done | failed
  error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (car_slug, kind)
);
