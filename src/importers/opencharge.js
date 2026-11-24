// Public EV chargers from Open Charge Map (needs a free API key).
import { config } from "../config.js";
import { query, rows } from "../db.js";
import { getJson } from "../lib/http.js";
import { CITY_CENTRES } from "./osm.js";

export async function runOpenChargeMap({ log = () => {}, radiusKm = 15, perCity = 30 } = {}) {
  if (!config.openChargeMapKey) throw new Error("OPENCHARGEMAP_API_KEY is not set in .env.");
  const cities = await rows("SELECT id, slug, name FROM cities ORDER BY sort");
  let total = 0;
  for (const city of cities) {
    const c = CITY_CENTRES[city.slug];
    if (!c) continue;
    const url = `https://api.openchargemap.io/v3/poi/?${new URLSearchParams({ output: "json", countrycode: "IN", latitude: String(c[0]), longitude: String(c[1]), distance: String(radiusKm), distanceunit: "KM", maxresults: String(perCity), compact: "true", verbose: "false", key: config.openChargeMapKey })}`;
    const list = await getJson(url, { timeout: 30000 });
    for (const p of list) {
      const a = p.AddressInfo ?? {};
      const conns = p.Connections ?? [];
      const kw = Math.max(0, ...conns.map((x) => x.PowerKW ?? 0));
      await query(
        `INSERT INTO stations (uid, kind, city_id, name, address, hours, connector, power, lat, lng, source) VALUES ($1,'ev',$2,$3,$4,$5,$6,$7,$8,$9,'openchargemap')
         ON CONFLICT (uid) DO UPDATE SET name=EXCLUDED.name, address=EXCLUDED.address, connector=EXCLUDED.connector, power=EXCLUDED.power, updated_at=now()`,
        [`ocm-${p.ID}`, city.id, a.Title ?? "EV charging point", [a.AddressLine1, a.Town].filter(Boolean).join(", ") || city.name, a.AccessComments ?? "", conns.length ? `${conns.length} connector${conns.length > 1 ? "s" : ""}` : null, kw ? Math.round(kw) : null, a.Latitude, a.Longitude],
      );
      total++;
    }
    log(`${city.name}: ${list.length} chargers.`);
  }
  return { total };
}
