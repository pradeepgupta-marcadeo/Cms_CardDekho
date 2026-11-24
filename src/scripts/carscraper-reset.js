// One-time switch of the website catalogue to CarScrapper data (asked for on 2026-11-16).
//   node src/scripts/carscraper-reset.js          shows what would be removed, changes nothing
//   node src/scripts/carscraper-reset.js --yes    does it
// Removes the catalogue built by the old Scraper section (VariantWise, automotive-scraper, Wikimedia photos) and the
// free data it imported (dealers, fuel and EV stations, fuel prices, road-tax slabs); demo offers, demo owner reviews
// and compare pairs go with the cars. News articles and news leads stay; their car links are moved to the new cars.
// Then every saved CarDekho car is written into the catalogue, and each old public car URL gets a single-hop 301.
// Take a database backup first (pg_dump), this cannot be undone.
import { getSetting, pool, query, rows, setSetting, tx } from "../db.js";
import { findCar, syncCatalogue } from "../lib/catalogue-sync.js";
import { contentChanged } from "../lib/publish.js";
import { addRedirect } from "../lib/redirects.js";

const TABS = ["price", "specs", "images", "colours", "mileage", "reviews", "offers", "emi", "dealers", "news", "faqs", "variants"];
const count = async (sql) => Number((await rows(sql))[0].n);

const plan = {
  cars: await count("SELECT count(*) AS n FROM cars"),
  publishedCars: await count("SELECT count(*) AS n FROM cars WHERE published"),
  variants: await count("SELECT count(*) AS n FROM variants"),
  carPhotos: await count("SELECT count(*) AS n FROM photos WHERE car_id IS NOT NULL"),
  brands: await count("SELECT count(*) AS n FROM brands"),
  offers: await count("SELECT count(*) AS n FROM offers"),
  ownerReviews: await count("SELECT count(*) AS n FROM owner_reviews"),
  realOwnerReviews: await count("SELECT count(*) AS n FROM owner_reviews WHERE NOT is_demo"),
  comparePairs: await count("SELECT count(*) AS n FROM compare_pairs"),
  dealers: await count("SELECT count(*) AS n FROM dealers"),
  stations: await count("SELECT count(*) AS n FROM stations"),
  fuelPrices: await count("SELECT count(*) AS n FROM fuel_prices"),
  scraperImports: await count("SELECT count(*) AS n FROM scraper_imports"),
  cardekhoCars: await count("SELECT count(*) AS n FROM cardekho_cars"),
};
console.log("Will remove:", plan);
if (!process.argv.includes("--yes")) {
  console.log("Nothing changed. Run again with --yes to do it.");
  await pool.end();
  process.exit(0);
}
if (!plan.cardekhoCars) throw new Error("No CarScrapper cars saved yet: run CarScrapper > Save to CMS database first.");

// Old public URLs and news links, to move them to the new cars afterwards.
const oldCars = await rows("SELECT c.id, c.slug, b.slug AS brand_slug, c.published, ARRAY(SELECT v.slug FROM variants v WHERE v.car_id = c.id) AS variants FROM cars c JOIN brands b ON b.id = c.brand_id");
const keyOf = new Map(oldCars.map((c) => [c.id, [c.brand_slug, c.slug]]));
const articleLinks = await rows("SELECT id, car_id, rival_id, photo_car_id FROM articles WHERE car_id IS NOT NULL OR rival_id IS NOT NULL OR photo_car_id IS NOT NULL");
const leadLinks = await rows("SELECT id, car_id FROM news_leads WHERE car_id IS NOT NULL");
const oldBrands = await rows("SELECT slug FROM brands");

await tx(async (c) => {
  for (const sql of [
    "DELETE FROM compare_pairs",
    "DELETE FROM offers",
    "DELETE FROM owner_reviews",
    "DELETE FROM photos WHERE car_id IS NOT NULL",
    "DELETE FROM variants",
    "DELETE FROM cars",
    "DELETE FROM dealers",
    "DELETE FROM stations",
    "DELETE FROM fuel_prices",
    "DELETE FROM brands",
    "DELETE FROM scraper_imports",
    "UPDATE cities SET tax_rules = NULL, tax_source = NULL",
  ]) {
    const r = await c.query(sql);
    console.log(`${sql}: ${r.rowCount}`);
  }
});
// The old daily car collector must not bring anything back.
await setSetting("auto_cars", { ...(await getSetting("auto_cars", {})), enabled: false });

const ctx = { summary: {}, log: (l) => console.log(l), change: () => {}, progress: () => {}, stopped: () => false };
await syncCatalogue(ctx);

// Move news links to the new cars (same model, maruti-suzuki -> maruti, windsor -> windsor-ev ...).
const resolved = new Map();
const newId = async (oldId) => {
  if (!oldId || !keyOf.has(oldId)) return null;
  if (!resolved.has(oldId)) resolved.set(oldId, (await findCar(...keyOf.get(oldId)))?.id ?? null);
  return resolved.get(oldId);
};
let relinked = 0;
for (const a of articleLinks) {
  const [car, rival, photo] = [await newId(a.car_id), await newId(a.rival_id), await newId(a.photo_car_id)];
  await query("UPDATE articles SET car_id = $2, rival_id = $3, photo_car_id = $4 WHERE id = $1", [a.id, car, rival, photo]);
  if (car || rival || photo) relinked += 1;
}
for (const l of leadLinks) await query("UPDATE news_leads SET car_id = $2 WHERE id = $1", [l.id, await newId(l.car_id)]);
console.log(`News: ${relinked} of ${articleLinks.length} articles linked to the new cars; ${leadLinks.length} news leads checked.`);

// 301s for every old public car URL whose address changed (guardrails: single hop, no broken links).
const newBrands = new Set((await rows("SELECT slug FROM brands")).map((b) => b.slug));
let redirects = 0;
for (const o of oldCars.filter((x) => x.published)) {
  const hit = await findCar(o.brand_slug, o.slug);
  const from = `/cars/${o.brand_slug}/${o.slug}`;
  const to = hit?.slug ? `/cars/${hit.brand_slug}/${hit.slug}` : hit?.brand_slug && newBrands.has(hit.brand_slug) ? `/brands/${hit.brand_slug}` : "/new-cars";
  if (from === to) continue; // same address: nothing to redirect (gone variants are redirected by the website itself)
  const modelMoved = Boolean(hit?.slug);
  await addRedirect(from, to);
  for (const t of TABS) await addRedirect(`${from}/${t}`, modelMoved ? `${to}/${t}` : to);
  for (const v of o.variants) await addRedirect(`${from}/variants/${v}`, modelMoved ? `${to}/variants` : to);
  redirects += 1 + TABS.length + o.variants.length;
}
for (const { slug } of oldBrands) {
  const b = slug === "maruti-suzuki" ? "maruti" : slug;
  if (b !== slug && newBrands.has(b)) {
    await addRedirect(`/brands/${slug}`, `/brands/${b}`);
    await addRedirect(`/news/brand/${slug}`, `/news/brand/${b}`);
    redirects += 2;
  } else if (!newBrands.has(slug)) {
    await addRedirect(`/brands/${slug}`, "/brands");
    redirects += 1;
  }
}
console.log(`Redirects: ${redirects} old addresses now point to their new page.`);
await contentChanged();
await new Promise((r) => setTimeout(r, 2500)); // let the debounced website refresh fire
await pool.end();
console.log("Done.");
