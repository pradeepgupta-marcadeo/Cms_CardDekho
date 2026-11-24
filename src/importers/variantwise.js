// Imports real Indian car data from the VariantWise Open Dataset (CC BY 4.0):
// prices, variants, engines, dimensions, features, and state road-tax slabs.
// Existing cars are updated in place; models we do not have yet are added
// unpublished, so an editor can add photos and publish them.
import { tx } from "../db.js";
import { getJson } from "../lib/http.js";
import { slugify } from "../lib/text.js";

export const SOURCE = { name: "VariantWise", url: "https://variantwise.com/data", license: "CC BY 4.0", credit: "Data: VariantWise (variantwise.com), CC BY 4.0" };
const CATALOGUE = "https://variantwise.com/data/catalogue.json";
const ROAD_TAX = "https://variantwise.com/data/road-tax.json";

const LUXURY = new Set(["bmw", "mercedes-benz", "audi", "lexus", "volvo", "land-rover", "mini", "porsche", "jaguar"]);
const FUEL = { petrol: "Petrol", diesel: "Diesel", cng: "CNG", electric: "Electric", hybrid: "Hybrid", "plug-in-hybrid": "Hybrid" };
const transOf = (t) => (/^\d*i?MT$/.test(t) ? "Manual" : "Automatic");

export function bodyOf(m) {
  const brand = slugify(m.brand);
  if (LUXURY.has(brand)) return "Luxury";
  if (["mpv", "van"].includes(m.bodyStyle)) return "MUV";
  if (m.bodyStyle === "hatchback") return "Hatchback";
  if (["sedan", "coupe", "convertible"].includes(m.bodyStyle)) return "Sedan";
  return "SUV";
}

const FEATURE_LABELS = [
  ["adas", (v) => v && v !== "none", (v) => `ADAS (${v})`],
  ["sunroof", (v) => v && v !== "none", (v) => (v === "panoramic" ? "Panoramic sunroof" : "Sunroof")],
  ["camera360", (v) => v, () => "360-degree camera"],
  ["ventilatedFrontSeats", (v) => v, () => "Ventilated front seats"],
  ["wirelessCharger", (v) => v, () => "Wireless charger"],
  ["headsUpDisplay", (v) => v, () => "Head-up display"],
  ["touchscreenIn", (v) => v, (v) => `${v}-inch touchscreen`],
  ["wirelessCarPlayAndroidAuto", (v) => v, () => "Wireless Android Auto and Apple CarPlay"],
  ["autoClimate", (v) => v, () => "Automatic climate control"],
  ["connectedCarTech", (v) => v, () => "Connected car tech"],
  ["cruiseControl", (v) => v, () => "Cruise control"],
  ["rearCamera", (v) => v, () => "Rear camera"],
  ["airbags", (v) => v, (v) => `${v} airbags`],
  ["wheelType", (v) => v === "alloy", (_v, f) => `${f.wheelSizeIn ?? ""}-inch alloy wheels`.replace(/^-/, "")],
];

export function highlights(f = {}) {
  return FEATURE_LABELS.filter(([k, ok]) => ok(f[k])).map(([k, , label]) => label(f[k], f)).slice(0, 4);
}

// Turns one VariantWise model into our car fields and variant rows.
export function mapModel(m) {
  const engines = new Map(m.engines.map((e) => [e.id, e]));
  const trims = new Map(m.trims.map((t) => [t.id, t]));
  const fuels = [...new Set(m.engines.map((e) => FUEL[e.fuel]).filter(Boolean))];
  const prices = m.variants.map((v) => v.price).filter((p) => typeof p === "number");
  const ice = m.engines.filter((e) => e.fuel !== "electric");
  const evs = m.engines.filter((e) => e.fuel === "electric");
  const maxBy = (list, k) => list.reduce((a, b) => ((b[k] ?? 0) > (a?.[k] ?? 0) ? b : a), null);
  const strongest = maxBy(m.engines, "powerPs");
  const torquiest = maxBy(m.engines, "torqueNm");
  // The dataset leaves a figure out when it could not verify it; fall back to its other mileage fields.
  const eff = (e) => e.officialEfficiency ?? e.mileageKmpl ?? Math.max(0, ...Object.values(e.officialEfficiencyByTransmission ?? {}).filter((v) => typeof v === "number"));
  const mostEfficient = ice.map((e) => ({ ...e, officialEfficiency: eff(e) || null })).reduce((a, b) => ((b.officialEfficiency ?? 0) > (a?.officialEfficiency ?? 0) ? b : a), null);
  const longest = maxBy(evs, "rangeKmClaimed");
  const levels = [...m.trims].sort((a, b) => a.level - b.level);
  const variants = m.variants
    .filter((v) => typeof v.price === "number")
    .sort((a, b) => a.price - b.price)
    .map((v, i) => {
      const e = engines.get(v.engineId);
      const t = trims.get(v.trimId);
      const fuel = FUEL[e?.fuel] ?? fuels[0] ?? "Petrol";
      const engineName = e?.fuel === "electric" ? `${e.batteryKwh ?? ""} kWh`.trim() : e?.displacementCc ? `${(e.displacementCc / 1000).toFixed(1)}${e.turbo ? " Turbo" : ""}` : "";
      return {
        slug: slugify(`${v.trimId}-${v.engineId}-${v.transmission}`).slice(0, 80),
        name: [t?.name ?? v.trimId, engineName, fuel === "Electric" ? "" : fuel, v.transmission].filter(Boolean).join(" "),
        fuel,
        trans: transOf(v.transmission),
        price: v.price,
        highlights: highlights(t?.features),
        sort: i,
        source_url: v.url ?? null,
      };
    });
  // Two variants can share trim, engine size and gearbox (e.g. RWD and 4WD); add what tells them apart,
  // so every variant page gets a unique title (guardrails).
  const seen = new Map();
  for (const v of variants) seen.set(v.name, (seen.get(v.name) ?? 0) + 1);
  for (const v of variants) {
    if (seen.get(v.name) < 2) continue;
    const src = m.variants.find((x) => slugify(`${x.trimId}-${x.engineId}-${x.transmission}`).slice(0, 80) === v.slug);
    const e = engines.get(src?.engineId);
    const tag = e?.driveType && !["FWD"].includes(e.driveType) ? e.driveType : e?.mildHybrid ? "Mild Hybrid" : (e?.name.match(/\(([^)]+)\)/)?.[1] ?? e?.name ?? "");
    if (tag) v.name = v.name.replace(new RegExp(` ${v.fuel === "Electric" ? "" : v.fuel} `), (m0) => ` ${tag}${m0}`.replace(/\s+/g, " "));
  }
  const counts = new Map();
  for (const v of variants) {
    const n = (counts.get(v.name) ?? 0) + 1;
    counts.set(v.name, n);
    if (n > 1) v.name = `${v.name} (${n})`;
  }
  return {
    vwId: m.id,
    brand: m.brand,
    brandSlug: slugify(m.brand),
    name: m.name,
    slug: slugify(m.name),
    body: bodyOf(m),
    fuels: fuels.length ? fuels : ["Petrol"],
    auto: variants.some((v) => v.trans === "Automatic"),
    seats: m.seats ?? 5,
    min: prices.length ? Math.min(...prices) : 0,
    max: prices.length ? Math.max(...prices) : 0,
    mileage: longest?.rangeKmClaimed && !ice.length ? `${longest.rangeKmClaimed} km` : mostEfficient?.officialEfficiency ? `${mostEfficient.officialEfficiency} kmpl` : longest?.rangeKmClaimed ? `${longest.rangeKmClaimed} km` : "",
    engine: ice.length ? [...new Set(ice.map((e) => e.displacementCc).filter(Boolean))].sort((a, b) => a - b).map((cc) => `${cc} cc`).join(" / ") : evs.map((e) => e.batteryKwh).filter(Boolean).map((k) => `${k} kWh`).join(" / "),
    power: strongest?.powerPs ? `${strongest.powerPs} PS` : "",
    torque: torquiest?.torqueNm ? `${torquiest.torqueNm} Nm` : "",
    boot: m.bootLitres ?? 0,
    dims: { length: m.lengthMm ?? null, width: m.widthMm ?? null, height: m.heightMm ?? null, wheelbase: m.wheelbaseMm ?? null, tank: m.fuelTankL ?? null, frontSuspension: m.frontSuspension ?? null, rearSuspension: m.rearSuspension ?? null },
    features: { base: levels[0]?.features ?? null, top: levels.at(-1)?.features ?? null, baseTrim: levels[0]?.name ?? null, topTrim: levels.at(-1)?.name ?? null, ev: longest ? { batteryKwh: longest.batteryKwh ?? null, rangeKm: longest.rangeKmClaimed ?? null, acKw: longest.acChargingKw ?? null, dcKw: longest.dcChargingKw ?? null, fastChargeMinutes: longest.fastChargeMinutes ?? null } : null },
    variants,
  };
}

// Flattens one state's slab rules into what the website's on-road calculator needs.
export function taxRulesOf(state) {
  if (!state?.rules) return null;
  return state.rules.map((r) => ({ fuels: (r.fuels ?? []).map((f) => FUEL[f] ?? f), slabs: (r.slabs ?? []).map((s) => ({ uptoRs: s.uptoRs ?? null, pct: s.pct ?? null, flatRs: s.flatRs ?? null })), confidence: r.confidence ?? null }));
}

export async function runVariantwise({ log = () => {} } = {}) {
  const [cat, tax] = await Promise.all([getJson(CATALOGUE, { timeout: 60000 }), getJson(ROAD_TAX, { timeout: 60000 }).catch(() => null)]);
  log(`Downloaded ${cat.models.length} models (data as of ${cat.dataAsOf}).`);
  const summary = { dataAsOf: cat.dataAsOf, updated: [], added: [], priceChanges: [], unmatched: [], variants: 0, cities: 0 };

  await tx(async (c) => {
    const { rows: cars } = await c.query("SELECT c.id, c.slug, c.name, c.min_price, c.max_price, c.source, b.slug AS brand_slug FROM cars c JOIN brands b ON b.id = c.brand_id");
    const byKey = new Map(cars.map((x) => [`${x.brand_slug}-${x.slug}`, x]));
    const byVwId = new Map(cars.filter((x) => x.source?.vwId).map((x) => [x.source.vwId, x]));
    const { rows: brands } = await c.query("SELECT id, slug FROM brands");
    const brandId = new Map(brands.map((b) => [b.slug, b.id]));
    const seen = new Set();

    for (const model of cat.models) {
      const m = mapModel(model);
      if (!m.variants.length) continue;
      const existing = byVwId.get(m.vwId) ?? byKey.get(`${m.brandSlug}-${m.slug}`) ?? byKey.get(m.vwId);
      const source = { ...SOURCE, vwId: m.vwId, asOf: cat.dataAsOf };
      let carId;
      if (existing) {
        carId = existing.id;
        seen.add(existing.id);
        if (Math.abs(existing.min_price - m.min) > 0.001 || Math.abs(existing.max_price - m.max) > 0.001) {
          summary.priceChanges.push({ car: `${m.brand} ${existing.name}`, from: [existing.min_price, existing.max_price], to: [m.min, m.max] });
        }
        await c.query(
          // Missing figures keep what the car already has, rather than blanking it.
          `UPDATE cars SET fuels=$2, auto=$3, seats=$4, min_price=$5, max_price=$6, mileage=COALESCE(NULLIF($7, ''), mileage), engine=COALESCE(NULLIF($8, ''), engine), power=COALESCE(NULLIF($9, ''), power), torque=COALESCE(NULLIF($10, ''), torque), boot=CASE WHEN $11 > 0 THEN $11 ELSE boot END, dims=$12, features=$13, source=$14, updated_at=now() WHERE id=$1`,
          [carId, m.fuels, m.auto, m.seats, m.min, m.max, m.mileage, m.engine, m.power, m.torque, m.boot, m.dims, m.features, source],
        );
        summary.updated.push(`${m.brand} ${existing.name}`);
      } else {
        let bId = brandId.get(m.brandSlug);
        if (!bId) {
          const r = await c.query("INSERT INTO brands (slug, name, sort) VALUES ($1, $2, 100) RETURNING id", [m.brandSlug, m.brand]);
          bId = r.rows[0].id;
          brandId.set(m.brandSlug, bId);
        }
        const r = await c.query(
          `INSERT INTO cars (brand_id, slug, name, body, status, published, fuels, auto, seats, min_price, max_price, mileage, engine, power, torque, boot, popularity, angle, dims, features, source)
           VALUES ($1,$2,$3,$4,'on-sale',false,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,40,'',$15,$16,$17)
           ON CONFLICT (brand_id, slug) DO UPDATE SET updated_at = now() RETURNING id`,
          [bId, m.slug, m.name, m.body, m.fuels, m.auto, m.seats, m.min, m.max, m.mileage, m.engine, m.power, m.torque, m.boot, m.dims, m.features, source],
        );
        carId = r.rows[0].id;
        summary.added.push(`${m.brand} ${m.name}`);
      }
      await c.query("DELETE FROM variants WHERE car_id = $1", [carId]);
      for (const v of m.variants) {
        await c.query("INSERT INTO variants (car_id, slug, name, fuel, trans, price, highlights, sort, source_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (car_id, slug) DO NOTHING", [carId, v.slug, v.name, v.fuel, v.trans, v.price, v.highlights, v.sort, v.source_url]);
      }
      summary.variants += m.variants.length;
    }
    // Our cars the dataset has no match for: an editor can link them by setting the VariantWise ID.
    summary.unmatched = cars.filter((x) => !seen.has(x.id)).map((x) => `${x.brand_slug}-${x.slug}`);

    if (tax?.states) {
      const states = Array.isArray(tax.states) ? tax.states : Object.values(tax.states);
      const { rows: cities } = await c.query("SELECT id, slug, name, state FROM cities");
      for (const city of cities) {
        const st = states.find((s) => s.name.toLowerCase() === city.state.toLowerCase());
        if (!st) continue;
        await c.query("UPDATE cities SET tax_rules = $2, tax_source = $3, updated_at = now() WHERE id = $1", [city.id, JSON.stringify(taxRulesOf(st)), { ...SOURCE, state: st.name, kind: st.kind ?? null, asOf: tax.dataAsOf ?? cat.dataAsOf, registrationFeeRs: tax.national?.registrationFeeRs ?? null }]);
        summary.cities += 1;
      }
    }
  });
  log(`Updated ${summary.updated.length} cars, added ${summary.added.length} new models (unpublished), ${summary.variants} variants, road tax for ${summary.cities} cities.`);
  return summary;
}
