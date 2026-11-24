// CarScrapper "Fuel prices": puts today's petrol, diesel and CNG prices on the website's fuel price pages.
// For each city in the CMS: CarDekho's rate for the city, else the rate for its state (both read by
// scrape.py --fuel into fuel_prices.json); when CarDekho has neither, the official PPAC rate (four metros only).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { query, rows } from "../db.js";
import { fetchPpac, ppacMetroFor } from "../importers/ppac.js";
import { contentChanged } from "./publish.js";
import { slugify } from "./text.js";

/** Picks the price for one city: { petrol, diesel, cng, source } or null when CarDekho has none. */
export function pickFuel(city, data) {
  const own = data.cities?.[city.slug] ?? data.cities?.[slugify(city.name ?? "")];
  const state = data.states?.[slugify(city.state ?? "")];
  for (const [p, label] of [[own, "CarDekho"], [state, `CarDekho (${city.state} state rate)`]]) {
    if (p?.petrol && p?.diesel) return { petrol: p.petrol, diesel: p.diesel, cng: p.cng ?? own?.cng ?? state?.cng ?? null, source: label };
  }
  return null;
}

export async function importFuel(ctx, dataDir, onlySlugs = null) {
  const file = path.join(dataDir, "fuel_prices.json");
  if (!existsSync(file)) throw new Error("fuel_prices.json not found: the fuel scrape did not run.");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const cities = await rows("SELECT id, slug, name, state FROM cities WHERE ($1::text[] IS NULL OR slug = ANY($1)) ORDER BY sort, name", [onlySlugs]);
  const fuel = (ctx.summary.fuel ??= { cardekho: 0, state: 0, ppac: 0, missing: 0 });
  const missing = [];
  const save = (city, p, date) =>
    query(
      `INSERT INTO fuel_prices (city_id, petrol, diesel, cng, price_date, source, is_demo) VALUES ($1,$2,$3,$4,$5,$6,false)
       ON CONFLICT (city_id) DO UPDATE SET petrol = EXCLUDED.petrol, diesel = EXCLUDED.diesel, cng = EXCLUDED.cng, price_date = EXCLUDED.price_date,
         source = EXCLUDED.source, is_demo = false, updated_at = now()`,
      [city.id, p.petrol, p.diesel, p.cng ?? null, date, p.source],
    );
  for (const city of cities) {
    const p = pickFuel(city, data);
    if (!p) {
      missing.push(city);
      continue;
    }
    await save(city, p, data.date);
    if (p.source === "CarDekho") fuel.cardekho += 1;
    else fuel.state += 1;
    ctx.change(`FUEL     ${city.name} | petrol ₹${p.petrol}, diesel ₹${p.diesel}${p.cng ? `, CNG ₹${p.cng}` : ""} (${p.source})`);
  }
  if (missing.length) {
    ctx.log(`Fuel: CarDekho has no price for ${missing.map((c) => c.name).join(", ")}; trying the official PPAC rates.`);
    let ppac = null;
    try {
      ppac = await fetchPpac();
    } catch (err) {
      ctx.log(`Fuel: PPAC could not be read (${err.message}).`);
    }
    for (const city of missing) {
      const metro = ppacMetroFor(city.slug);
      const p = ppac && metro ? ppac.prices.find((x) => x.city === metro) : null;
      if (!p) {
        fuel.missing += 1;
        ctx.log(`Fuel: no price for ${city.name} from CarDekho or PPAC; its old price (if any) stays.`);
        continue;
      }
      await save(city, { petrol: p.petrol, diesel: p.diesel, cng: null, source: "PPAC (Government of India)" }, ppac.date);
      fuel.ppac += 1;
      ctx.change(`FUEL     ${city.name} | petrol ₹${p.petrol}, diesel ₹${p.diesel} (PPAC, Government of India)`);
    }
  }
  ctx.log(`Fuel prices for ${data.date}: ${fuel.cardekho} cities from CarDekho, ${fuel.state} from their state rate, ${fuel.ppac} from PPAC, ${fuel.missing} without a price.`);
  await contentChanged();
}
