// CarScrapper -> website catalogue. Turns the saved CarDekho rows (cardekho_cars, cardekho_variants, cardekho_photos)
// into the tables the website reads (brands, cars, variants, photos), in the shapes the website expects
// (see website/src/data/cars.ts). Editor-written copy (guide, pros, cons, FAQs, angle, keywords, rating) is never
// overwritten; facts, variants and CarDekho photos are replaced on every sync. Unchanged cars are skipped.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { one, rows, tx } from "../db.js";
import { contentChanged } from "./publish.js";
import { syncKeywordBank } from "./keyword-sync.js";
import { slugify } from "./text.js";

export const SOURCE = { name: "CarDekho", url: "https://www.cardekho.com", license: "All rights reserved", credit: "Data: CarDekho" };
const PHOTO_LICENSE = "© CarDekho / manufacturer";
const LUXURY = new Set(["aston-martin", "audi", "bentley", "bmw", "bugatti", "ferrari", "jaguar", "lamborghini", "land-rover", "lexus", "lotus", "maserati", "mclaren", "mercedes-benz", "mini", "porsche", "rolls-royce", "volvo", "genesis", "denza"]);
const MASS = new Set(["maruti", "hyundai", "tata", "mahindra", "kia", "toyota", "honda", "mg", "skoda", "volkswagen", "renault", "nissan", "citroen"]);

const num = (v) => {
  const m = /(\d+(?:\.\d+)?)/.exec(String(v ?? "").replace(/,/g, ""));
  return m ? Number(m[1]) : null;
};
const int = (v) => (num(v) === null ? null : Math.round(num(v)));
const lakh = (rs) => (rs ? Math.round(Number(rs) / 1000) / 100 : 0); // rupees -> lakh, 2 decimals

/** CarDekho "Yes", "Wireless", "With Guidedlines", "Front Only" -> true; "Not Available", "No" -> false; missing -> null. */
export function yes(v) {
  if (v === undefined || v === null || v === "" || v === "-") return null;
  return !/^(not available|no|none|na|n\/a)$/i.test(String(v).trim());
}

/**
 * Strong and plug-in hybrids: CarDekho lists them as "Petrol" and says "Hybrid" only in the variant name or the engine
 * ("Innova Hycross ZX Hybrid", "M15D With Strong Hybrid", "Plug-in Hybrid"). Mild and "Smart" hybrids are petrol cars.
 */
export function isHybrid(text) {
  const s = String(text ?? "");
  return /hybrid|e-tech/i.test(s) && !/mild|smart hybrid/i.test(s);
}

export function fuelOf(v) {
  const s = String(v ?? "").toLowerCase();
  if (/electric|ev\b/.test(s)) return "Electric";
  if (/hybrid/.test(s)) return "Hybrid";
  if (/cng/.test(s)) return "CNG";
  if (/diesel/.test(s)) return "Diesel";
  return "Petrol";
}

export function bodyOf(brandSlug, bodyType) {
  if (LUXURY.has(brandSlug)) return "Luxury";
  const b = String(bodyType ?? "").toLowerCase();
  if (/hatch/.test(b)) return "Hatchback";
  if (/sedan|coupe|convertible/.test(b)) return "Sedan";
  if (/muv|mpv|minivan|van/.test(b)) return "MUV";
  return "SUV";
}

/** Every spec and feature of a record as one name -> value map. */
export function flatten(rec = {}) {
  const out = {};
  for (const g of ["specification", "features"]) for (const items of Object.values(rec[g] ?? {})) Object.assign(out, items);
  return out;
}

/** CarDekho variant sheet -> the website's feature keys (the ones its Safety and Comfort tables read). */
export function featureSet(rec = {}) {
  const f = flatten(rec);
  const section = (g, name) => Object.values(rec[g]?.[name] ?? {});
  const adas = section("features", "ADAS Feature").some((v) => yes(v));
  const sunroof = f.Sunroof;
  const wireless = /wireless/i.test(`${f["Apple CarPlay"] ?? ""} ${f["Android Auto"] ?? ""}`);
  return {
    airbags: int(f["No. of Airbags"]),
    esc: yes(f["Electronic Stability Control (ESC)"]),
    isofix: yes(f["ISOFIX Child Seat Mounts"]),
    tpms: yes(f["Tyre Pressure Monitoring System (TPMS)"]),
    rearCamera: yes(f["Rear Camera"]),
    camera360: yes(f["360 View Camera"]),
    adas: rec.features?.["ADAS Feature"] ? (adas ? "Yes" : "none") : null,
    touchscreenIn: num(f["Touchscreen Size"]),
    wirelessCarPlayAndroidAuto: f["Apple CarPlay"] || f["Android Auto"] ? wireless : null,
    autoClimate: yes(f["Automatic Climate Control"]),
    sunroof: sunroof === undefined ? null : yes(sunroof) ? String(sunroof).toLowerCase().replace(/\s+/g, "-") : "none",
    ventilatedFrontSeats: yes(f["Ventilated Seats"]),
    wirelessCharger: yes(f["Wireless Phone Charging"]),
    cruiseControl: yes(f["Cruise Control"]),
    connectedCarTech: rec.features?.["Advance Internet Feature"] ? section("features", "Advance Internet Feature").some((v) => yes(v)) : null,
    wheelSizeIn: num(f["Wheel Size"]),
    wheelType: /alloy/i.test(f["Wheels Type"] ?? "") ? "alloy" : f["Wheels Type"] ? "steel" : null,
  };
}

/** Up to four selling points of a variant, like the website shows on variant cards. */
export function highlights(fs) {
  const out = [];
  if (fs.adas === "Yes") out.push("ADAS");
  if (fs.sunroof && fs.sunroof !== "none") out.push(fs.sunroof === "panoramic" ? "Panoramic sunroof" : "Sunroof");
  if (fs.camera360) out.push("360-degree camera");
  if (fs.ventilatedFrontSeats) out.push("Ventilated front seats");
  if (fs.wirelessCharger) out.push("Wireless charger");
  if (fs.touchscreenIn) out.push(`${fs.touchscreenIn}-inch touchscreen`);
  if (fs.wirelessCarPlayAndroidAuto) out.push("Wireless Android Auto and Apple CarPlay");
  if (fs.autoClimate) out.push("Automatic climate control");
  if (fs.cruiseControl) out.push("Cruise control");
  if (fs.rearCamera) out.push("Rear camera");
  if (fs.airbags) out.push(`${fs.airbags} airbags`);
  return out.slice(0, 4);
}

/** "Aeris Smart Petrol MT" of "Tata Aeris" -> "Smart Petrol MT". */
export function variantName(raw, car) {
  let name = String(raw ?? "").trim();
  const prefixes = [car.name, car.model, car.name?.replace(new RegExp(`^${car.brand}\\s+`, "i"), "")].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    if (name.toLowerCase().startsWith(`${p.toLowerCase()} `)) {
      name = name.slice(p.length).trim();
      break;
    }
  }
  return name || "Standard";
}

/** Picture title -> the website's photo kinds. */
export function photoKind(title, kind, url = "") {
  if (kind === "colour") return "side";
  if (/carinteriorimages/.test(url)) return "interior";
  const t = String(title ?? "").toLowerCase().replace(/^driving:\s*/, "");
  // The source files it as an exterior photo ("Boot (Closed)", a door handle): it stays with the exterior ones.
  const outside = /carexteriorimages/.test(url);
  if (angleOf(t) !== null) return angleOf(t) === 0 || angleOf(t) === 45 || angleOf(t) === 315 ? "front" : angleOf(t) >= 135 && angleOf(t) <= 225 ? "rear" : "side";
  if (!outside && /interior|dashboard|steering|seat|cabin|console|infotainment|instrument|gear|ac |vents|door view|boot|trunk|rear seats|sunroof/.test(t)) return "interior";
  if (/wheel|headlight|taillight|tail lamp|head lamp|grille|mirror|exhaust|badge|fog|drl|charging/.test(t)) return "detail";
  if (/^front|front view|front left|front right/.test(t)) return "front";
  if (/rear|boot|trunk|tailgate/.test(t)) return "rear";
  if (/side|profile/.test(t)) return "side";
  return "front";
}

/**
 * Where the camera stands around the car in an exterior angle shot, in degrees: 0 front, 45 front left,
 * 90 left side, 135 rear left, 180 rear, 225 rear right, 270 right side, 315 front right. null for any other photo.
 */
export function angleOf(title) {
  const t = String(title ?? "").toLowerCase().replace(/^driving:\s*/, "").replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  if (/^front view$/.test(t)) return 0;
  if (/^rear view$/.test(t)) return 180;
  const corner = /^(front|rear) (left|right)( three quarter| quarter| side)?( view)?$/.exec(t);
  if (corner) return { "front left": 45, "front right": 315, "rear left": 135, "rear right": 225 }[`${corner[1]} ${corner[2]}`];
  if (/^side (profile )?(view )?left( view)?$|^left side( view)?$/.test(t)) return 90;
  if (/^side (profile )?(view )?right( view)?$|^right side( view)?$/.test(t)) return 270;
  return null;
}

const maxBy = (list, f) => list.reduce((best, x) => (f(x) > f(best) ? x : best), list[0]);

/** Overview sections from the source review text, for cars that have no guide written yet. */
export function overviewFrom(review = []) {
  return review
    .filter((r) => r?.text)
    .map((r) => {
      const sentences = r.text.split(/(?<=[.!?])\s+(?=[A-Z0-9“"])/);
      const p = [];
      for (let i = 0; i < sentences.length; i += 3) p.push(sentences.slice(i, i + 3).join(" "));
      return { h: r.title || "Overview", p };
    });
}

/** Car name without its brand: "Hyundai 2027 Hyundai i20" of Hyundai -> "2027 i20"; "Tata Punch" -> "Punch". */
export function modelName(name, brand, fallback = "") {
  const full = String(name ?? "").trim();
  const b = String(brand ?? "").trim().toLowerCase();
  if (!b) return full || fallback;
  const words = full.split(/\s+/);
  const size = b.split(/\s+/).length;
  const out = [];
  for (let i = 0; i < words.length; i++) {
    if (words.slice(i, i + size).join(" ").toLowerCase() === b) i += size - 1;
    else out.push(words[i]);
  }
  return out.join(" ") || fallback || full;
}

/** CarDekho slugs on its Latest cars page (saved by scrape.py), shown as "new launch" on the website. */
export function latestSlugs() {
  const file = path.join(path.dirname(config.carScraper.script), "cardekho_data", "latest.json");
  try {
    return new Set(existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).slugs ?? []) : []);
  } catch {
    return new Set();
  }
}

/** Maps one saved CarDekho car (+ its variants and copied photos) to website catalogue rows. */
/**
 * Real on-road prices of one car, from cardekho_city_prices rows: variant URL -> { citySlug: { total, rto?, insurance?, other? } }.
 * RTO and insurance are known only for the variant CarDekho breaks down on each city page (the base one).
 */
export function cityPriceMap(cityRows = []) {
  const byUrl = {};
  for (const r of cityRows) {
    const d = r.data ?? {};
    const b = d.base_breakup;
    for (const v of d.variants ?? []) {
      if (!v.url || !(Number(v.on_road) > 0)) continue;
      const entry = { total: Math.round(Number(v.on_road)) };
      if (b && b.url === v.url && b.rto != null && b.insurance != null) Object.assign(entry, { rto: b.rto, insurance: b.insurance, other: b.other ?? 0 });
      (byUrl[v.url] ??= {})[r.city_slug] = entry;
    }
  }
  return byUrl;
}

export function mapCar(row, variantRows, photoRows, latest = new Set(), onRoadByUrl = {}) {
  const d = row.data ?? {};
  const brandSlug = row.slug.split("/")[0];
  const model = { ...d, name: row.name, model: row.model, brand: row.brand };
  const sheets = variantRows.length ? variantRows.map((v) => v.data ?? {}) : [];
  // Upcoming cars often have no variant pages yet: use the list on the model page.
  const list = sheets.length
    ? sheets.map((s) => ({ name: s.variant, fuel: s.fuel, trans: s.transmission, price: s.ex_showroom, url: s.url, sheet: s, hybrid: isHybrid(`${s.variant} ${flatten(s)["Engine Type"] ?? ""}`) }))
    : (d.variants ?? []).map((v) => ({ name: v.name, fuel: v.fuel ?? d.fuel, trans: /manual|mt\b/i.test(`${v.key_specs ?? ""} ${v.name}`) ? "Manual" : "Automatic", price: v.ex_showroom, url: v.url, sheet: null, hybrid: isHybrid(`${v.name} ${v.key_specs ?? ""}`) }));
  const priced = list.filter((v) => Number(v.price) > 0).sort((a, b) => a.price - b.price);
  const used = new Map();
  const variants = priced.map((v, i) => {
    let name = variantName(v.name, model);
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    const fs = v.sheet ? featureSet(v.sheet) : {};
    return { slug: slugify(name).slice(0, 80) || `variant-${i + 1}`, name, fuel: v.hybrid && !/electric|cng|diesel/i.test(v.fuel ?? "") ? "Hybrid" : fuelOf(v.fuel), trans: /auto|amt|cvt|dct|at\b/i.test(v.trans ?? "") ? "Automatic" : "Manual", price: lakh(v.price), highlights: highlights(fs), sort: i, onRoad: (v.url && onRoadByUrl[v.url]) || null };
  });
  const prices = variants.map((v) => v.price);
  const fuels = [...new Set([...variants.map((v) => v.fuel), ...String(row.fuel ?? "").split("/").map((s) => s.trim()).filter(Boolean).map(fuelOf)])];
  const ev = fuels.length === 1 && fuels[0] === "Electric";
  const base = sheets.length ? sheets.reduce((a, b) => ((b.ex_showroom ?? Infinity) < (a.ex_showroom ?? Infinity) ? b : a)) : null;
  const top = sheets.length ? sheets.reduce((a, b) => ((b.ex_showroom ?? 0) > (a.ex_showroom ?? 0) ? b : a)) : null;
  const all = { ...flatten(d), ...(base ? flatten(base) : {}) };
  const cc = [...new Set(sheets.map((s) => int(s.engine_cc)).filter(Boolean))].sort((a, b) => a - b);
  const kwh = [...new Set(sheets.map((s) => num(s.battery)).filter(Boolean))].sort((a, b) => a - b);
  const strongest = sheets.length ? maxBy(sheets, (s) => num(s.max_power) ?? 0) : null;
  const torquiest = sheets.length ? maxBy(sheets, (s) => num(s.max_torque) ?? 0) : null;
  const ranges = sheets.map((s) => int(s.range_km)).filter(Boolean);
  const evRange = ranges.length ? Math.max(...ranges) : int(row.range_km);
  const ncap = int(all["Bharat NCAP Safety Rating"]) ?? int(all["Global NCAP Safety Rating"]) ?? 0;
  const colors = (d.colours ?? []).filter((c) => c?.name).map((c) => ({ name: c.name, hex: /^#[0-9a-f]{3,8}$/i.test(c.hex ?? "") ? c.hex : "#9ca3af" }));
  // Public credit: short licence text and the car's page on the source site (not the raw picture address).
  const photos = photoRows.filter((p) => p.url).map((p, i) => ({ src: p.url, w: p.w, h: p.h, kind: photoKind(p.title, p.kind, p.source_url), credit: SOURCE.name, license: PHOTO_LICENSE, page: row.url ?? SOURCE.url, sort: (p.kind === "colour" ? 1000 : 0) + i, colour: p.kind === "colour" ? p.title : null, title: p.kind === "colour" ? null : p.title, angle: p.kind === "colour" ? null : angleOf(p.title), grp: p.kind === "colour" ? null : (p.grp ?? null) }));
  return {
    brandSlug,
    brand: row.brand,
    slug: slugify(row.slug.split("/")[1]),
    name: modelName(row.name, row.brand, row.model),
    body: bodyOf(brandSlug, row.body_type),
    status: row.kind === "upcoming" ? "upcoming" : latest.has(row.slug) ? "new-launch" : "on-sale",
    fuels: fuels.length ? fuels : ["Petrol"],
    auto: variants.some((v) => v.trans === "Automatic") || /auto/i.test(row.transmission ?? ""),
    // The model page can list only the base layout (Alcazar: 5); the variant sheets give every layout (6 and 7).
    seats: Math.max(row.seats || 0, ...sheets.map((x) => int(x.seats) || 0)) || int(all["Seating Capacity"]) || 5,
    min: prices.length ? Math.min(...prices) : lakh(row.ex_showroom_min),
    max: prices.length ? Math.max(...prices) : lakh(row.ex_showroom_max ?? row.ex_showroom_min),
    mileage: ev ? (evRange ? `${evRange} km` : "") : (row.mileage ?? ""),
    engine: ev ? kwh.map((k) => `${k} kWh`).join(" / ") : cc.map((c) => `${c} cc`).join(" / "),
    power: strongest && num(strongest.max_power) ? `${num(strongest.max_power)} bhp` : "",
    torque: torquiest && num(torquiest.max_torque) ? `${num(torquiest.max_torque)} Nm` : "",
    boot: int(all["Boot Space"] ?? all["Reported Boot Space"]) ?? 0,
    ncap: ncap > 5 ? 0 : ncap,
    launch: row.kind === "upcoming" ? (row.expected_launch ?? null) : null,
    popularity: row.kind === "upcoming" ? 30 : (MASS.has(brandSlug) ? 70 : 45) + Math.min(variants.length, 20),
    colors,
    dims: {
      length: int(all.Length), width: int(all.Width), height: int(all.Height), wheelbase: int(all["Wheel Base"]),
      tank: int(all["Petrol Fuel Tank Capacity"] ?? all["Diesel Fuel Tank Capacity"] ?? all["CNG Fuel Tank Capacity"]),
      frontSuspension: all["Front Suspension"] ?? null, rearSuspension: all["Rear Suspension"] ?? null,
    },
    features: {
      // Without variant sheets the website would print generic rows; empty sets make it show only what is known.
      base: base ? featureSet(base) : {}, top: top ? featureSet(top) : {},
      baseTrim: base ? variantName(base.variant, model) : null, topTrim: top ? variantName(top.variant, model) : null,
      ev: ev ? { batteryKwh: kwh.at(-1) ?? num(row.battery), rangeKm: evRange ?? null, acKw: null, dcKw: null, fastChargeMinutes: null } : null,
      // The complete source sheets, so the website can list every specification and feature.
      sheet: { specification: (top ?? d).specification ?? d.specification ?? {}, features: (top ?? d).features ?? d.features ?? {} },
    },
    // The guide is our own AI copy (CarScrapper > Car pages); CarDekho's review text is research only, never shown.
    overview: [],
    source: { ...SOURCE, url: row.url ?? SOURCE.url, asOf: row.scraped_at ? new Date(row.scraped_at).toISOString().slice(0, 10) : null, cardekhoSlug: row.slug },
    variants,
    photos,
  };
}

const hashOf = (m) => createHash("sha1").update(JSON.stringify({ ...m, source: { ...m.source, asOf: null } })).digest("hex");

/** Writes the saved CarDekho cars into the website catalogue. ctx: { log, change, progress, stopped, summary }. */
export async function syncCatalogue(ctx, { slugs = null, brand = null, kind = null, quiet = false } = {}) {
  const site = (ctx.summary.site ??= { NEW: 0, UPDATED: 0, SAME: 0, hidden: 0 });
  const latest = latestSlugs();
  const cars = await rows(`SELECT * FROM cardekho_cars WHERE ($1::text[] IS NULL OR slug = ANY($1)) AND ($2::text IS NULL OR slug LIKE $2 || '/%') AND ($3::text IS NULL OR kind = $3) ORDER BY kind, slug`, [slugs, brand, kind]);
  if (!quiet) ctx.log(`Website: checking ${cars.length} ${kind ? `${kind} ` : ""}car${cars.length === 1 ? "" : "s"} …`);
  const brandIds = new Map((await rows("SELECT id, slug FROM brands")).map((b) => [b.slug, b.id]));
  let changed = false;
  for (const [n, row] of cars.entries()) {
    if (ctx.stopped()) break;
    const variantRows = await rows("SELECT data FROM cardekho_variants WHERE car_slug = $1", [row.slug]);
    const photoRows = await rows("SELECT p.kind, p.title, p.grp, p.source_url, m.url, m.w, m.h, m.license FROM cardekho_photos p JOIN media m ON m.id = p.media_id WHERE p.car_slug = $1 AND p.status = 'done' ORDER BY p.kind DESC, p.sort", [row.slug]);
    const cityRows = await rows("SELECT city_slug, data FROM cardekho_city_prices WHERE car_slug = $1", [row.slug]).catch(() => []);
    const m = mapCar(row, variantRows, photoRows, latest, cityPriceMap(cityRows));
    const hash = hashOf(m);
    const res = await tx(async (c) => {
      let bId = brandIds.get(m.brandSlug);
      if (!bId) {
        bId = (await c.query("INSERT INTO brands (slug, name, sort) VALUES ($1, $2, $3) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id", [m.brandSlug, m.brand, MASS.has(m.brandSlug) ? 10 : 100])).rows[0].id;
        brandIds.set(m.brandSlug, bId);
      }
      const old = (await c.query("SELECT id, name, source, jsonb_array_length(overview) AS ov FROM cars WHERE brand_id = $1 AND slug = $2", [bId, m.slug])).rows[0];
      if (old && old.source?.hash === hash) return "SAME";
      const source = { ...m.source, hash };
      let carId;
      if (old) {
        carId = old.id;
        await c.query(
          `UPDATE cars SET body=$2, status=$3, fuels=$4, auto=$5, seats=$6, min_price=$7, max_price=$8, mileage=$9, engine=$10, power=$11, torque=$12, boot=$13,
           ncap=$14, launch=$15, colors=$16, dims=$17, features=$18, source=$19, overview = CASE WHEN $21 = 0 THEN $20::jsonb ELSE overview END, updated_at=now() WHERE id=$1`,
          [carId, m.body, m.status, m.fuels, m.auto, m.seats, m.min, m.max, m.mileage, m.engine, m.power, m.torque, m.boot, m.ncap, m.launch, JSON.stringify(m.colors), m.dims, m.features, source, JSON.stringify(m.overview), old.ov],
        );
        // Names saved before the brand was cleaned out ("2027 Hyundai i20" under Hyundai) are corrected; other names stay.
        if (old.name !== m.name && modelName(old.name, m.brand) !== old.name) await c.query("UPDATE cars SET name = $2 WHERE id = $1", [carId, m.name]);
      } else {
        carId = (await c.query(
          `INSERT INTO cars (brand_id, slug, name, body, status, published, fuels, auto, seats, min_price, max_price, mileage, engine, power, torque, boot, ncap, launch, popularity, angle, colors, dims, features, overview, source)
           VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'',$19,$20,$21,$22,$23) RETURNING id`,
          [bId, m.slug, m.name, m.body, m.status, m.fuels, m.auto, m.seats, m.min, m.max, m.mileage, m.engine, m.power, m.torque, m.boot, m.ncap, m.launch, m.popularity, JSON.stringify(m.colors), m.dims, m.features, JSON.stringify(m.overview), source],
        )).rows[0].id;
      }
      await c.query("DELETE FROM variants WHERE car_id = $1", [carId]);
      for (const v of m.variants) {
        await c.query("INSERT INTO variants (car_id, slug, name, fuel, trans, price, highlights, sort, on_road) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (car_id, slug) DO NOTHING", [carId, v.slug, v.name, v.fuel, v.trans, v.price, v.highlights, v.sort, v.onRoad ? JSON.stringify(v.onRoad) : null]);
      }
      // Only the CarDekho photos are replaced; photos an editor added stay.
      await c.query("DELETE FROM photos WHERE car_id = $1 AND credit = $2", [carId, SOURCE.name]);
      for (const p of m.photos) {
        await c.query("INSERT INTO photos (car_id, src, w, h, kind, credit, license, page, sort, colour, colour_by, title, angle, grp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", [carId, p.src, p.w, p.h, p.kind, p.credit, p.license, p.page, p.sort, p.colour, p.colour ? "source" : "", p.title, p.angle, p.grp]);
      }
      return old ? "UPDATED" : "NEW";
    });
    site[res] += 1;
    if (res !== "SAME") {
      changed = true;
      const live = m.photos.length && m.colors.length && m.variants.some((v) => v.price > 0);
      if (!live) site.hidden += 1;
      ctx.change(`WEBSITE  ${row.name} | ${res === "NEW" ? "added" : "updated"} · ${m.variants.length} variants · ${m.photos.length} photos · ${m.colors.length} colours${live ? "" : " · not shown yet (needs a photo, a colour and a price)"}`);
    }
    if (!quiet) ctx.progress(n + 1, cars.length);
  }
  if (!quiet) {
    const pairs = await rebuildComparePairs();
    ctx.log(`Website: ${pairs.made} comparisons from CarDekho's "compare with" lists${pairs.changed ? " (updated)" : ""}.`);
    if (pairs.changed) changed = true;
  }
  if (changed) {
    // New or changed cars get their search phrases (and phrases for removed pages go) before the site refreshes.
    await contentChanged();
    await syncKeywordBank((line) => ctx.log(line)).catch((err) => ctx.log(`Keywords: not updated (${err.message})`));
    await contentChanged();
  }
  if (!quiet) ctx.log(`Website: ${site.NEW} added, ${site.UPDATED} updated, ${site.SAME} unchanged${site.hidden ? `, ${site.hidden} waiting for a photo, colour or price` : ""}.`);
  return site;
}

/**
 * Comparison pairs from CarDekho's own "compare with similar cars" list: most popular cars first, each paired with
 * the first of its listed rivals that is on the website. Each car appears at most twice; no pair twice.
 * cars: [{ id, slug (CarDekho slug), popularity, rivals: [CarDekho slugs] }] of cars live on the website.
 */
export function pickPairs(cars, max = 24) {
  const bySlug = new Map(cars.map((c) => [c.slug, c]));
  const used = new Map();
  const seen = new Set();
  const pairs = [];
  for (const a of [...cars].sort((x, y) => y.popularity - x.popularity || x.slug.localeCompare(y.slug))) {
    if (pairs.length >= max) break;
    if ((used.get(a.id) ?? 0) >= 2) continue;
    const b = (a.rivals ?? []).map((s) => bySlug.get(s)).find((r) => r && r.id !== a.id && (used.get(r.id) ?? 0) < 2 && !seen.has([a.id, r.id].sort().join("-")));
    if (!b) continue;
    seen.add([a.id, b.id].sort().join("-"));
    for (const id of [a.id, b.id]) used.set(id, (used.get(id) ?? 0) + 1);
    pairs.push([a.id, b.id]);
  }
  return pairs;
}

/** Replaces the website's comparison pairs with ones picked from the CarDekho lists. */
export async function rebuildComparePairs() {
  const cars = await rows(`SELECT c.id, c.popularity, c.source->>'cardekhoSlug' AS slug, COALESCE(d.data->'compare_with', '[]'::jsonb) AS rivals
    FROM cars c JOIN cardekho_cars d ON d.slug = c.source->>'cardekhoSlug'
    WHERE c.published AND jsonb_array_length(c.colors) > 0 AND EXISTS (SELECT 1 FROM photos p WHERE p.car_id = c.id)`);
  const pairs = pickPairs(cars.map((c) => ({ ...c, rivals: c.rivals.map((r) => r.slug) })));
  const before = (await rows("SELECT a_id, b_id FROM compare_pairs ORDER BY sort, id")).map((p) => `${p.a_id}-${p.b_id}`).join(",");
  if (before === pairs.map(([a, b]) => `${a}-${b}`).join(",")) return { made: pairs.length, changed: false };
  await tx(async (c) => {
    await c.query("DELETE FROM compare_pairs");
    for (const [i, [a, b]] of pairs.entries()) await c.query("INSERT INTO compare_pairs (a_id, b_id, sort) VALUES ($1, $2, $3) ON CONFLICT (a_id, b_id) DO NOTHING", [a, b, i]);
  });
  return { made: pairs.length, changed: true };
}

/** Old URL key -> new car, for relinking news and adding redirects after the old catalogue is removed. */
export async function findCar(brandSlug, slug) {
  const alias = { "maruti-suzuki": "maruti" };
  const b = alias[brandSlug] ?? brandSlug;
  const list = await rows("SELECT c.id, c.slug, b.slug AS brand_slug FROM cars c JOIN brands b ON b.id = c.brand_id WHERE b.slug = $1", [b]);
  const exact = list.find((c) => c.slug === slug);
  if (exact) return exact;
  const near = list.filter((c) => c.slug.startsWith(`${slug}-`) || slug.startsWith(`${c.slug}-`)).sort((x, y) => x.slug.length - y.slug.length);
  return near[0] ?? (list.length ? { id: null, slug: null, brand_slug: b } : null);
}

export const carCount = async () => (await one("SELECT count(*)::int AS n FROM cars")).n;
