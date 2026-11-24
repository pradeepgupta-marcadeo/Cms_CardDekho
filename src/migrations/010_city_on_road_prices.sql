-- CarScrapper "On-road prices by city": CarDekho's on-road price of every variant in each city of the website.
CREATE TABLE IF NOT EXISTS cardekho_city_prices (
  key TEXT PRIMARY KEY,                   -- "tata/punch|mumbai"
  car_slug TEXT NOT NULL,                 -- CarDekho car slug
  city_slug TEXT NOT NULL,                -- the website's city slug
  data JSONB NOT NULL,                    -- { variants: [{ url, name, ex_showroom, on_road }], base_breakup: { url, rto, insurance, other, on_road } }
  scraped_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cardekho_city_prices_car_idx ON cardekho_city_prices (car_slug);

-- Real on-road price of a variant per city, read by the website before its own estimate:
-- { "mumbai": { "total": 1185435, "rto": 65804, "insurance": 33916, "other": 0 }, ... } (rto / insurance only when known).
ALTER TABLE variants ADD COLUMN IF NOT EXISTS on_road JSONB;
