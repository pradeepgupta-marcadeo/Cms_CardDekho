-- CarScrapper tab: data saved from ../cardekho/scrape.py. Kept apart from the website catalogue (cars, variants, photos):
-- nothing here is shown on the website.
CREATE TABLE IF NOT EXISTS cardekho_cars (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,              -- "tata/punch"
  kind TEXT NOT NULL CHECK (kind IN ('launched', 'upcoming')),
  brand TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  status TEXT,
  expected_launch TEXT,
  price_range TEXT,
  ex_showroom_min BIGINT,
  ex_showroom_max BIGINT,
  body_type TEXT,
  fuel TEXT,
  transmission TEXT,
  seats INT,
  airbags INT,
  range_km TEXT,
  battery TEXT,
  mileage TEXT,
  variants_count INT NOT NULL DEFAULT 0,
  main_image TEXT,                        -- original picture address
  description TEXT,
  latest_update TEXT,
  url TEXT,
  data JSONB NOT NULL,                    -- the whole scraped record (colours, pictures, specs, features, review ...)
  scraped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cardekho_cars_brand_idx ON cardekho_cars (brand);
CREATE INDEX IF NOT EXISTS cardekho_cars_kind_idx ON cardekho_cars (kind);

CREATE TABLE IF NOT EXISTS cardekho_variants (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  car_slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('launched', 'upcoming')),
  brand TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  variant TEXT NOT NULL DEFAULT '',
  status TEXT,
  tag TEXT,
  fuel TEXT,
  transmission TEXT,
  price_text TEXT,
  ex_showroom BIGINT,
  on_road BIGINT,
  engine_cc TEXT,
  max_power TEXT,
  max_torque TEXT,
  seats INT,
  airbags INT,
  range_km TEXT,
  battery TEXT,
  mileage TEXT,
  data JSONB NOT NULL,                    -- the whole record (price breakup, specification, features ...)
  scraped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cardekho_variants_car_idx ON cardekho_variants (car_slug);

-- Pictures copied into the Media library (one row per original picture address).
CREATE TABLE IF NOT EXISTS cardekho_photos (
  id SERIAL PRIMARY KEY,
  car_slug TEXT NOT NULL,
  source_url TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'picture' CHECK (kind IN ('picture', 'colour')),
  title TEXT NOT NULL DEFAULT '',
  sort INT NOT NULL DEFAULT 0,
  media_id INT REFERENCES media(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('done', 'failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cardekho_photos_car_idx ON cardekho_photos (car_slug);
