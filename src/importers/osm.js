// Fuel pumps, EV chargers and car showrooms around each city from OpenStreetMap
// (Overpass API). Data © OpenStreetMap contributors, ODbL: the website credits it.
import { query, rows } from "../db.js";
import { fetchWithRetry } from "../lib/http.js";

// Public Overpass servers; each is tried in turn when one is busy.
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

// City centres for the Overpass radius search. Add a city here when you add one in the CMS.
export const CITY_CENTRES = {
  "new-delhi": [28.6139, 77.209], mumbai: [19.076, 72.8777], bangalore: [12.9716, 77.5946], hyderabad: [17.385, 78.4867],
  pune: [18.5204, 73.8567], jaipur: [26.9124, 75.7873], kanpur: [26.4499, 80.3319], lucknow: [26.8467, 80.9462],
  chennai: [13.0827, 80.2707], kolkata: [22.5726, 88.3639], ahmedabad: [23.0225, 72.5714], chandigarh: [30.7333, 76.7794],
};

async function overpass(q) {
  let last;
  for (const url of OVERPASS) {
    try {
      const res = await fetchWithRetry(url, { method: "POST", body: new URLSearchParams({ data: q }), timeout: 60000, tries: 1 });
      if (res.ok) return (await res.json()).elements ?? [];
      last = new Error(`${res.status} from ${new URL(url).host}`);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

const addressOf = (t, cityName) => [t["addr:housenumber"], t["addr:street"], t["addr:suburb"] ?? t["addr:neighbourhood"], t["addr:city"] ?? cityName].filter(Boolean).join(", ") || cityName;
const pointOf = (e) => (e.type === "node" ? [e.lat, e.lon] : [e.center?.lat, e.center?.lon]);

export async function runOsm({ kinds = ["fuel", "ev", "dealer"], radiusKm = 12, perCity = 25, log = () => {} } = {}) {
  const cities = await rows("SELECT id, slug, name FROM cities ORDER BY sort");
  const brands = await rows("SELECT id, slug, name FROM brands");
  const summary = { fuel: 0, ev: 0, dealer: 0, skippedCities: [] };
  for (const city of cities) {
    const centre = CITY_CENTRES[city.slug];
    if (!centre) {
      summary.skippedCities.push(city.name);
      continue;
    }
    const around = `(around:${radiusKm * 1000},${centre[0]},${centre[1]})`;
    // One small query per kind: a busy server or a slow city then only loses that part.
    const QUERIES = { fuel: `nwr${around}["amenity"="fuel"]["name"];`, ev: `nwr${around}["amenity"="charging_station"];`, dealer: `nwr${around}["shop"="car"]["name"];` };
    const elements = [];
    for (const k of kinds) {
      try {
        elements.push(...(await overpass(`[out:json][timeout:50];(${QUERIES[k]});out center tags ${perCity * 3};`)));
      } catch (err) {
        log(`${city.name}: ${k} skipped (${err.message}).`);
      }
    }
    const counts = { fuel: 0, ev: 0, dealer: 0 };
    for (const e of elements) {
      const t = e.tags ?? {};
      const [lat, lng] = pointOf(e);
      const uid = `osm-${e.type}-${e.id}`;
      if (t.amenity === "fuel" && counts.fuel < perCity) {
        const fuels = ["Petrol", "Diesel", ...(t["fuel:cng"] === "yes" ? ["CNG"] : [])];
        const name = [t.brand && !t.name.includes(t.brand) ? t.brand : "", t.name].filter(Boolean).join(" ");
        await query(
          `INSERT INTO stations (uid, kind, city_id, name, address, hours, fuels, lat, lng, source) VALUES ($1,'fuel',$2,$3,$4,$5,$6,$7,$8,'openstreetmap')
           ON CONFLICT (uid) DO UPDATE SET name=EXCLUDED.name, address=EXCLUDED.address, hours=EXCLUDED.hours, fuels=EXCLUDED.fuels, lat=EXCLUDED.lat, lng=EXCLUDED.lng, updated_at=now()`,
          [uid, city.id, name, addressOf(t, city.name), t.opening_hours === "24/7" ? "Open 24 hours" : t.opening_hours ?? "", fuels, lat, lng],
        );
        counts.fuel++;
      } else if (t.amenity === "charging_station" && counts.ev < perCity) {
        const sockets = Object.keys(t).filter((k) => k.startsWith("socket:") && !k.includes(":output")).map((k) => k.split(":")[1].toUpperCase().replace("TYPE2_COMBO", "CCS2").replace("TYPE2", "Type 2").replace("CHADEMO", "CHAdeMO"));
        const kw = Number(String(t["socket:type2_combo:output"] ?? t["charging_station:output"] ?? "").replace(/[^\d.]/g, "")) || null;
        const name = t.name ?? `${t.operator ?? t.brand ?? "EV"} charging point`;
        await query(
          `INSERT INTO stations (uid, kind, city_id, name, address, hours, connector, power, lat, lng, source) VALUES ($1,'ev',$2,$3,$4,$5,$6,$7,$8,$9,'openstreetmap')
           ON CONFLICT (uid) DO UPDATE SET name=EXCLUDED.name, address=EXCLUDED.address, hours=EXCLUDED.hours, connector=EXCLUDED.connector, power=EXCLUDED.power, lat=EXCLUDED.lat, lng=EXCLUDED.lng, updated_at=now()`,
          [uid, city.id, name, addressOf(t, city.name), t.opening_hours === "24/7" ? "Open 24 hours" : t.opening_hours ?? "", [...new Set(sockets)].join(" + ") || null, kw ? Math.round(kw) : null, lat, lng],
        );
        counts.ev++;
      } else if (t.shop === "car" && counts.dealer < perCity) {
        const hay = `${t.brand ?? ""} ${t.name}`.toLowerCase();
        const brand = brands.find((b) => hay.includes(b.name.toLowerCase()) || hay.includes(b.slug.replace(/-/g, " ")) || (b.slug === "maruti-suzuki" && /maruti|nexa|arena/.test(hay)));
        if (!brand) continue;
        await query(
          `INSERT INTO dealers (uid, brand_id, city_id, name, address, hours, phone, verified, lat, lng, source) VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,$9,'openstreetmap')
           ON CONFLICT (uid) DO UPDATE SET name=EXCLUDED.name, address=EXCLUDED.address, hours=EXCLUDED.hours, phone=EXCLUDED.phone, lat=EXCLUDED.lat, lng=EXCLUDED.lng, updated_at=now()`,
          [uid, brand.id, city.id, t.name, addressOf(t, city.name), t.opening_hours ?? "", t.phone ?? t["contact:phone"] ?? "", lat, lng],
        );
        counts.dealer++;
      }
    }
    for (const k of Object.keys(counts)) summary[k] += counts[k];
    log(`${city.name}: ${counts.fuel} fuel, ${counts.ev} EV, ${counts.dealer} dealers.`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  return summary;
}

