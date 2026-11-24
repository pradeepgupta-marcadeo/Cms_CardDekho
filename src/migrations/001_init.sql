-- Wheelora CMS schema. Every table here feeds one part of the website; the
-- CMS turns them into a single snapshot the website reads (see lib/snapshot.js).

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor')),
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Login sessions (used by connect-pg-simple).
CREATE TABLE IF NOT EXISTS session (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);

-- Key/value settings: site name, analytics IDs, navigation menus, etc.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brands (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  logo JSONB,
  description TEXT NOT NULL DEFAULT '',
  sort INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cities (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  rto NUMERIC(6, 4) NOT NULL DEFAULT 0.1,
  ins NUMERIC(6, 4) NOT NULL DEFAULT 0.05,
  sort INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cars (
  id SERIAL PRIMARY KEY,
  brand_id INT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT 'SUV',
  status TEXT NOT NULL DEFAULT 'on-sale' CHECK (status IN ('on-sale', 'upcoming', 'new-launch')),
  published BOOLEAN NOT NULL DEFAULT true,
  fuels TEXT[] NOT NULL DEFAULT '{}',
  auto BOOLEAN NOT NULL DEFAULT false,
  seats INT NOT NULL DEFAULT 5,
  min_price NUMERIC(10, 2) NOT NULL DEFAULT 0,
  max_price NUMERIC(10, 2) NOT NULL DEFAULT 0,
  mileage TEXT NOT NULL DEFAULT '',
  engine TEXT NOT NULL DEFAULT '',
  power TEXT NOT NULL DEFAULT '',
  torque TEXT NOT NULL DEFAULT '',
  boot INT NOT NULL DEFAULT 0,
  ncap INT NOT NULL DEFAULT 0,
  rating NUMERIC(3, 1) NOT NULL DEFAULT 0,
  reviews INT NOT NULL DEFAULT 0,
  popularity INT NOT NULL DEFAULT 50,
  launch TEXT,
  angle TEXT NOT NULL DEFAULT '',
  pros TEXT[] NOT NULL DEFAULT '{}',
  cons TEXT[] NOT NULL DEFAULT '{}',
  colors JSONB NOT NULL DEFAULT '[]',
  dims JSONB,
  features JSONB,
  model3d JSONB,
  overview JSONB NOT NULL DEFAULT '[]',
  faqs JSONB NOT NULL DEFAULT '[]',
  keywords JSONB NOT NULL DEFAULT '[]',
  source JSONB,
  is_demo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (brand_id, slug)
);

CREATE TABLE IF NOT EXISTS variants (
  id SERIAL PRIMARY KEY,
  car_id INT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  fuel TEXT NOT NULL,
  trans TEXT NOT NULL DEFAULT 'Manual',
  price NUMERIC(10, 2) NOT NULL,
  highlights TEXT[] NOT NULL DEFAULT '{}',
  sort INT NOT NULL DEFAULT 0,
  source_url TEXT,
  UNIQUE (car_id, slug)
);

-- Photos: car_id set for car photos, site_key set for site photos (e.g. "showroom").
CREATE TABLE IF NOT EXISTS photos (
  id SERIAL PRIMARY KEY,
  car_id INT REFERENCES cars(id) ON DELETE CASCADE,
  site_key TEXT,
  src TEXT NOT NULL,
  w INT NOT NULL,
  h INT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'front',
  credit TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  page TEXT NOT NULL DEFAULT '',
  sort INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS photos_car_idx ON photos (car_id);

CREATE TABLE IF NOT EXISTS articles (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('news', 'review', 'advice')),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'news',
  author TEXT NOT NULL DEFAULT 'Wheelora Desk',
  published_on DATE NOT NULL DEFAULT CURRENT_DATE,
  minutes INT NOT NULL DEFAULT 5,
  car_id INT REFERENCES cars(id) ON DELETE SET NULL,
  rival_id INT REFERENCES cars(id) ON DELETE SET NULL,
  photo_car_id INT REFERENCES cars(id) ON DELETE SET NULL,
  body JSONB NOT NULL DEFAULT '[]',
  keywords JSONB NOT NULL DEFAULT '[]',
  seo JSONB NOT NULL DEFAULT '{}',
  source JSONB,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
  ai_generated BOOLEAN NOT NULL DEFAULT false,
  is_demo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, slug)
);

CREATE TABLE IF NOT EXISTS offers (
  id SERIAL PRIMARY KEY,
  car_id INT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  amount INT NOT NULL,
  type TEXT NOT NULL,
  valid_till DATE NOT NULL,
  is_demo BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dealers (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  brand_id INT REFERENCES brands(id) ON DELETE CASCADE,
  city_id INT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  hours TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  verified BOOLEAN NOT NULL DEFAULT false,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  source TEXT NOT NULL DEFAULT 'manual',
  is_demo BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- EV chargers and fuel pumps share one table, split by kind.
CREATE TABLE IF NOT EXISTS stations (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('ev', 'fuel')),
  city_id INT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  hours TEXT NOT NULL DEFAULT '',
  connector TEXT,
  power INT,
  fuels TEXT[] NOT NULL DEFAULT '{}',
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  source TEXT NOT NULL DEFAULT 'manual',
  is_demo BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fuel_prices (
  id SERIAL PRIMARY KEY,
  city_id INT NOT NULL UNIQUE REFERENCES cities(id) ON DELETE CASCADE,
  petrol NUMERIC(6, 2) NOT NULL,
  diesel NUMERIC(6, 2) NOT NULL,
  cng NUMERIC(6, 2),
  price_date DATE NOT NULL DEFAULT CURRENT_DATE,
  source TEXT NOT NULL DEFAULT 'manual',
  is_demo BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Owner reviews: website visitors submit them, editors approve them here.
CREATE TABLE IF NOT EXISTS owner_reviews (
  id SERIAL PRIMARY KEY,
  car_id INT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  is_demo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- News topics, /new-cars facets, collections and visual stories.
CREATE TABLE IF NOT EXISTS topics (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  nav_label TEXT NOT NULL,
  h1 TEXT NOT NULL,
  intro TEXT NOT NULL,
  guide TEXT NOT NULL,
  category TEXT,
  fuel TEXT,
  sort INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS lists (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('facet', 'collection', 'story')),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  h1 TEXT NOT NULL DEFAULT '',
  intro TEXT NOT NULL DEFAULT '',
  rule JSONB NOT NULL DEFAULT '{}',
  max_items INT NOT NULL DEFAULT 8,
  sort INT NOT NULL DEFAULT 0,
  UNIQUE (kind, slug)
);

CREATE TABLE IF NOT EXISTS compare_pairs (
  id SERIAL PRIMARY KEY,
  a_id INT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  b_id INT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  sort INT NOT NULL DEFAULT 0,
  UNIQUE (a_id, b_id)
);

CREATE TABLE IF NOT EXISTS faqs (
  id SERIAL PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'home',
  q TEXT NOT NULL,
  a TEXT NOT NULL,
  sort INT NOT NULL DEFAULT 0
);

-- Editable text on the website (hero heading, section titles, footer text).
CREATE TABLE IF NOT EXISTS blocks (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  page TEXT NOT NULL DEFAULT '/',
  sort INT NOT NULL DEFAULT 0
);

-- Per-URL SEO overrides. Anything left empty falls back to the page's own text.
CREATE TABLE IF NOT EXISTS seo_pages (
  path TEXT PRIMARY KEY,
  title TEXT,
  description TEXT,
  noindex BOOLEAN NOT NULL DEFAULT false,
  keywords JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS keywords (
  id SERIAL PRIMARY KEY,
  phrase TEXT NOT NULL UNIQUE,
  intent TEXT NOT NULL DEFAULT 'informational',
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'long-tail')),
  volume INT,
  difficulty INT,
  target_path TEXT,
  source TEXT NOT NULL DEFAULT 'generated',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS keywords_path_idx ON keywords (target_path);

CREATE TABLE IF NOT EXISTS redirects (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL UNIQUE,
  destination TEXT NOT NULL,
  permanent BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL,
  url TEXT NOT NULL,
  w INT NOT NULL,
  h INT NOT NULL,
  bytes INT NOT NULL,
  alt TEXT NOT NULL DEFAULT '',
  credit TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Story leads found by the news fetcher. An editor turns one into an article.
CREATE TABLE IF NOT EXISTS news_leads (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  summary TEXT NOT NULL DEFAULT '',
  car_id INT REFERENCES cars(id) ON DELETE SET NULL,
  is_launch BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'drafted', 'ignored')),
  article_id INT REFERENCES articles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_runs (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  summary JSONB NOT NULL DEFAULT '{}',
  log TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- First-party analytics: page views and tracked clicks sent by the website.
CREATE TABLE IF NOT EXISTS analytics_events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  target TEXT,
  referrer TEXT,
  device TEXT,
  visitor TEXT
);
CREATE INDEX IF NOT EXISTS analytics_ts_idx ON analytics_events (ts);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
