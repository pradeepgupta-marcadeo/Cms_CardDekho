// Showrooms read by `scrape.py --dealers` (dealers.jsonl) -> the dealers table, which the car pages' Dealers tab
// lists by brand and city. Rows from this import carry source "cardekho"; a showroom that is no longer listed is
// removed, while dealers an editor added by hand are never touched.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { query, rows } from "../db.js";
import { contentChanged } from "./publish.js";

export async function importDealers(ctx, dataDir) {
  const file = path.join(dataDir, "dealers.jsonl");
  if (!existsSync(file)) return ctx.log("No dealers.jsonl yet: nothing to save.");
  const brands = new Map((await rows("SELECT id, slug FROM brands")).map((b) => [b.slug, b.id]));
  const cities = new Map((await rows("SELECT id, slug FROM cities")).map((c) => [c.slug, c.id]));
  const seen = [];
  let saved = 0;
  let skipped = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const cityId = cities.get(d?.citySlug);
    // A showroom of a brand the website does not carry (Fiat, Datsun...) would show nowhere: left out.
    if (!d?.uid || !d.name || !d.address || !cityId || !brands.has(d.brandSlug)) {
      skipped += 1;
      continue;
    }
    await query(
      `INSERT INTO dealers (uid, brand_id, city_id, name, address, hours, phone, lat, lng, source, verified, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'cardekho',false,now())
       ON CONFLICT (uid) DO UPDATE SET brand_id = EXCLUDED.brand_id, city_id = EXCLUDED.city_id, name = EXCLUDED.name, address = EXCLUDED.address,
         hours = EXCLUDED.hours, phone = EXCLUDED.phone, lat = EXCLUDED.lat, lng = EXCLUDED.lng, updated_at = now()
       WHERE dealers.source = 'cardekho'`,
      [d.uid, brands.get(d.brandSlug) ?? null, cityId, d.name, d.address, d.hours ?? "", d.phone ?? "", d.lat ?? null, d.lng ?? null],
    );
    seen.push(d.uid);
    saved += 1;
  }
  // A full list was read: showrooms that dropped off it are closed or moved.
  const gone = seen.length ? (await query("DELETE FROM dealers WHERE source = 'cardekho' AND NOT (uid = ANY($1))", [seen])).rowCount : 0;
  ctx.summary.dealers = { saved, skipped, removed: gone };
  await contentChanged(); // the website shows the new list
  ctx.change(`DEALERS  ${saved} showrooms saved${gone ? `, ${gone} no longer listed removed` : ""}${skipped ? `, ${skipped} skipped (brand or city not on the website)` : ""}`);
}
