// Fills an empty database with the website's current content and the first admin.
// Safe to run again: it skips anything that already exists.
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { ROOT, assertConfig, config } from "../config.js";
import { pool, setSetting, tx } from "../db.js";
import { BLOCKS, COLLECTIONS, FACETS, STORIES } from "../lib/catalog.js";
import { carKeywords, siteKeywords } from "../lib/keywords.js";

assertConfig();

const snap = JSON.parse(readFileSync(path.join(ROOT, "seed", "demo-snapshot.json"), "utf8"));
const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const isoFromHuman = (s) => {
  const m = String(s).match(/^(\d{1,2}) (\w{3}) (\d{4})$/);
  return m ? new Date(Date.UTC(+m[3], months[m[2]], +m[1])).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
};

async function seed() {
  await tx(async (c) => {
    const { rows: existing } = await c.query("SELECT count(*)::int AS n FROM cars");
    if (existing[0].n > 0) {
      console.log("Content already seeded; only checking the admin user.");
    } else {
      await seedContent(c);
    }
    await seedAdmin(c);
  });
  await pool.end();
}

async function seedAdmin(c) {
  const { email, password, name } = config.seedAdmin;
  if (!email || !password) return console.log("SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set; no admin created.");
  const found = await c.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
  if (found.rowCount) return console.log(`Admin ${email} already exists.`);
  const hash = await bcrypt.hash(password, 12);
  await c.query("INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'admin')", [email.toLowerCase(), name, hash]);
  console.log(`Created admin ${email}`);
}

async function seedContent(c) {
  await setSetting("site", { ...snap.site, url: "" }, c);
  await setSetting("analytics", { ga4Id: "", clarityId: "", gscVerification: "", bingVerification: "", firstParty: true }, c);
  await setSetting("nav", snap.nav, c);
  await setSetting("footer", snap.footer, c);
  await setSetting("content_version", Date.now(), c);

  const cityId = {};
  for (const [i, city] of snap.cities.entries()) {
    const r = await c.query("INSERT INTO cities (slug, name, state, rto, ins, sort) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [city.slug, city.name, city.state, city.rto, city.ins, i]);
    cityId[city.slug] = r.rows[0].id;
  }

  const brandId = {};
  const brandOrder = [...new Set(snap.cars.map((x) => x.brandSlug))];
  for (const [i, slug] of brandOrder.entries()) {
    const car = snap.cars.find((x) => x.brandSlug === slug);
    const logo = snap.brandLogos[slug] ?? null;
    const r = await c.query("INSERT INTO brands (slug, name, logo, sort) VALUES ($1,$2,$3,$4) RETURNING id", [slug, car.brand, logo, i]);
    brandId[slug] = r.rows[0].id;
  }

  const carId = {};
  for (const car of snap.cars) {
    const r = await c.query(
      `INSERT INTO cars (brand_id, slug, name, body, status, fuels, auto, seats, min_price, max_price, mileage, engine, power, torque, boot, ncap, rating, reviews, popularity, launch, angle, pros, cons, colors, model3d)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING id`,
      [brandId[car.brandSlug], car.slug, car.name, car.body, car.status, car.fuels, car.auto, car.seats, car.min, car.max, car.mileage, car.engine, car.power, car.torque, car.boot, car.ncap, car.rating, car.reviews, car.popularity, car.launch ?? null, car.angle, car.pros, car.cons, JSON.stringify(car.colors), car.model3d ? JSON.stringify(car.model3d) : null],
    );
    const id = r.rows[0].id;
    carId[car.key] = id;
    for (const [i, p] of car.photos.entries()) {
      await c.query("INSERT INTO photos (car_id, src, w, h, kind, credit, license, page, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [id, p.src, p.w, p.h, p.kind, p.credit, p.license, p.page, i]);
    }
  }
  for (const [key, list] of Object.entries(snap.sitePhotos)) {
    for (const [i, p] of list.entries()) {
      await c.query("INSERT INTO photos (site_key, src, w, h, kind, credit, license, page, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [key, p.src, p.w, p.h, p.kind, p.credit, p.license, p.page, i]);
    }
  }

  for (const a of snap.articles) {
    // News bodies were generated from the car data at render time; keep that behaviour by storing no body.
    const body = a.kind === "news" ? [] : a.body;
    await c.query(
      `INSERT INTO articles (kind, slug, title, excerpt, category, author, published_on, minutes, car_id, rival_id, photo_car_id, body, status, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'published',$13) ON CONFLICT (kind, slug) DO NOTHING`,
      [a.kind, a.slug, a.title, a.excerpt, a.category, a.author, isoFromHuman(a.date), a.minutes, carId[a.car] ?? null, carId[a.rival] ?? null, carId[a.photo] ?? null, JSON.stringify(body), a.kind !== "advice"],
    );
  }

  for (const o of snap.offers) {
    await c.query("INSERT INTO offers (car_id, amount, type, valid_till, is_demo) VALUES ($1,$2,$3,$4,true)", [carId[o.car], o.amount, o.type, addDays(o.daysLeft)]);
  }
  for (const d of snap.dealers) {
    const brand = snap.cars.find((x) => x.brand === d.brand)?.brandSlug;
    await c.query("INSERT INTO dealers (uid, brand_id, city_id, name, address, hours, phone, verified, source, is_demo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'demo',true)", [d.id, brandId[brand], cityId[d.citySlug], d.name, d.address, d.hours, d.phone, d.verified]);
  }
  for (const s of snap.evStations) {
    await c.query("INSERT INTO stations (uid, kind, city_id, name, address, hours, connector, power, source, is_demo) VALUES ($1,'ev',$2,$3,$4,$5,$6,$7,'demo',true)", [s.id, cityId[s.citySlug], s.name, s.address, s.hours, s.connector, s.power]);
  }
  for (const s of snap.fuelStations) {
    await c.query("INSERT INTO stations (uid, kind, city_id, name, address, hours, fuels, source, is_demo) VALUES ($1,'fuel',$2,$3,$4,$5,$6,'demo',true)", [s.id, cityId[s.citySlug], s.name, s.address, s.hours, s.fuels]);
  }
  for (const f of snap.fuelPrices) {
    await c.query("INSERT INTO fuel_prices (city_id, petrol, diesel, cng, source, is_demo) VALUES ($1,$2,$3,$4,'demo',true)", [cityId[f.slug], f.petrol.toFixed(2), f.diesel.toFixed(2), f.cng.toFixed(2)]);
  }
  for (const r of snap.ownerReviews) {
    await c.query("INSERT INTO owner_reviews (car_id, author, rating, title, text, status, is_demo, created_at) VALUES ($1,$2,$3,$4,$5,'approved',true,$6)", [carId[r.car], r.author, r.rating, r.title, r.text, isoFromHuman(r.date)]);
  }

  for (const [i, [key, t]] of Object.entries(snap.topics).entries()) {
    await c.query("INSERT INTO topics (key, label, nav_label, h1, intro, guide, category, fuel, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [key, t.label, t.navLabel, t.h1, t.intro, t.guide, t.category ?? null, t.fuel ?? null, i]);
  }
  for (const [i, [slug, title, h1, intro, rule]] of FACETS.entries()) {
    await c.query("INSERT INTO lists (kind, slug, title, h1, intro, rule, max_items, sort) VALUES ('facet',$1,$2,$3,$4,$5,100,$6)", [slug, title, h1, intro, JSON.stringify(rule), i]);
  }
  for (const [i, [slug, title, intro, rule]] of COLLECTIONS.entries()) {
    await c.query("INSERT INTO lists (kind, slug, title, intro, rule, max_items, sort) VALUES ('collection',$1,$2,$3,$4,8,$5)", [slug, title, intro, JSON.stringify(rule), i]);
  }
  for (const [i, [slug, title, intro, rule]] of STORIES.entries()) {
    await c.query("INSERT INTO lists (kind, slug, title, intro, rule, max_items, sort) VALUES ('story',$1,$2,$3,$4,5,$5)", [slug, title, intro, JSON.stringify(rule), i]);
  }
  for (const [i, [a, b]] of snap.comparePairs.entries()) {
    if (carId[a] && carId[b]) await c.query("INSERT INTO compare_pairs (a_id, b_id, sort) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [carId[a], carId[b], i]);
  }
  for (const [i, f] of snap.faqsHome.entries()) {
    await c.query("INSERT INTO faqs (scope, q, a, sort) VALUES ('home',$1,$2,$3)", [f.q, f.a, i]);
  }
  for (const [i, b] of BLOCKS.entries()) {
    await c.query("INSERT INTO blocks (key, value, label, hint, page, sort) VALUES ($1,$2,$3,$4,$5,$6)", [b.key, b.value, b.label, b.hint, b.page, i]);
  }

  const pairs = snap.comparePairs;
  const all = [...siteKeywords(snap.cities)];
  for (const car of snap.cars) {
    const rivals = pairs
      .filter(([a, b]) => a === car.key || b === car.key)
      .map(([a, b]) => ({ name: snap.cars.find((x) => x.key === (a === car.key ? b : a))?.name, pairSlug: `${a}-vs-${b}` }))
      .filter((r) => r.name);
    all.push(...carKeywords(car, { cities: snap.cities, rivals }));
  }
  for (const k of all) {
    await c.query("INSERT INTO keywords (phrase, intent, priority, target_path, source) VALUES ($1,$2,$3,$4,'pattern') ON CONFLICT (phrase) DO NOTHING", [k.phrase, k.intent, k.priority, k.target_path]);
  }

  console.log(`Seeded ${snap.cars.length} cars, ${snap.articles.length} articles, ${all.length} keywords.`);
}

seed().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
