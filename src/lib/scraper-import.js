// Maps approved scraper records into the CMS's own tables (brands, cars,
// variants, photos, news_leads). Rules:
//  - a car is matched by the scraper's model ID, then brand + slug, then the
//    VariantWise ID; a new car is created hidden (published = false);
//  - an existing car is only updated after an admin confirms the shown diff;
//  - CMS-only fields (name, URL, published, status, body, copy, ratings, SEO)
//    are never touched; only catalogue facts, variants and licensed photos are;
//  - every import runs in one transaction and is recorded in scraper_imports.
import { one, query, rows, tx } from "../db.js";
import { localizeImage } from "./localize.js";
import { audit, contentChanged } from "./publish.js";
import { scraper } from "./scraper-client.js";
import { slugify } from "./text.js";

const LUXURY = new Set(["bmw", "mercedes-benz", "audi", "lexus", "volvo", "land-rover", "mini", "porsche", "jaguar"]);
const FUEL = { Petrol: "Petrol", Diesel: "Diesel", CNG: "CNG", Electric: "Electric", Hybrid: "Hybrid", "Plug-in Hybrid": "Hybrid", "Mild Hybrid": "Petrol", LPG: "Petrol" };
const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const lakh = (rupees) => (rupees ? Math.round((Number(rupees) / 1e5) * 100) / 100 : null);

export function cmsBody(bundle) {
  if (LUXURY.has(bundle.brand.slug)) return "Luxury";
  const b = String(bundle.bodyType ?? "");
  if (/hatch/i.test(b)) return "Hatchback";
  if (/sedan|coupe$|convertible/i.test(b)) return "Sedan";
  if (/mpv|muv|van/i.test(b)) return "MUV";
  return "SUV";
}

const photoKind = (c) => (/front|quarter/.test(c) && !/rear/.test(c) ? "front" : /rear/.test(c) && !/seat/.test(c) ? "rear" : c === "side_profile" ? "side" : /interior|seat|infotainment|steering/.test(c) ? "interior" : "detail");

// The website's spec tables read these keys (see website src/data/cars.ts specGroups).
function featureSet(v) {
  if (!v) return null;
  const f = Object.fromEntries((v.features ?? []).map((x) => [x.feature.key, x]));
  const has = (k) => (f[k] ? f[k].available : null);
  const s = v.specification ?? {};
  return {
    airbags: s.airbags ?? null,
    esc: s.esc ?? null,
    isofix: s.isofix ?? null,
    tpms: has("tpms"),
    rearCamera: has("rear-camera"),
    camera360: has("camera-360"),
    adas: f.adas ? (f.adas.available ? f.adas.value ?? "yes" : "none") : null,
    touchscreenIn: f.touchscreen?.available ? n(String(f.touchscreen.value ?? "").match(/[\d.]+/)?.[0]) : f.touchscreen ? 0 : null,
    wirelessCarPlayAndroidAuto: f["android-auto"] ? f["android-auto"].value === "wireless" : null,
    autoClimate: has("automatic-climate-control"),
    sunroof: f.sunroof ? (f.sunroof.available ? f.sunroof.value ?? "yes" : "none") : null,
    ventilatedFrontSeats: has("ventilated-seats"),
    wirelessCharger: has("wireless-charging"),
    cruiseControl: has("cruise-control"),
    connectedCarTech: has("connected-car"),
  };
}

/** The CMS fields a scraper model bundle provides. */
export function mapModel(bundle) {
  const live = bundle.variants.filter((v) => !v.discontinued && v.exShowroomPrice);
  const variants = live.map((v, i) => ({
    slug: v.slug.slice(0, 80),
    name: v.name,
    fuel: FUEL[v.fuelType] ?? "Petrol",
    trans: v.transmission === "Manual" ? "Manual" : "Automatic",
    price: lakh(v.exShowroomPrice),
    highlights: (v.features ?? []).filter((x) => x.available).slice(0, 4).map((x) => (x.value && !/^(true|yes)$/i.test(x.value) && x.feature.key !== "android-auto" && x.feature.key !== "apple-carplay" ? `${x.feature.name} (${x.value})` : x.feature.name)),
    sort: i,
    source_url: v.sourceUrl ?? null,
  }));
  const specs = live.map((v) => v.specification).filter(Boolean);
  const max = (k) => specs.reduce((m, s) => (n(s[k]) !== null && n(s[k]) > (m ?? -Infinity) ? n(s[k]) : m), null);
  const first = (k) => specs.map((s) => s[k]).find((x) => x !== null && x !== undefined) ?? null;
  const prices = variants.map((v) => v.price).filter(Boolean);
  const ccs = [...new Set(specs.map((s) => s.engineCapacityCc).filter(Boolean))].sort((a, b) => a - b);
  const kwh = [...new Set(specs.map((s) => n(s.batteryKwh)).filter(Boolean))].sort((a, b) => a - b);
  const fuels = [...new Set(variants.map((v) => v.fuel))];
  const evOnly = fuels.length === 1 && fuels[0] === "Electric";
  const mileage = evOnly ? (max("claimedRangeKm") ? `${max("claimedRangeKm")} km` : "") : max("araiMileageKmpl") ? `${max("araiMileageKmpl")} kmpl` : "";
  const sorted = [...live].sort((a, b) => Number(a.exShowroomPrice) - Number(b.exShowroomPrice));
  const evSpec = specs.find((s) => s.batteryKwh);
  return {
    fields: {
      min_price: prices.length ? Math.min(...prices) : null,
      max_price: prices.length ? Math.max(...prices) : null,
      fuels: fuels.length ? fuels : null,
      auto: variants.some((v) => v.trans === "Automatic"),
      seats: live.map((v) => v.seating).filter(Boolean).reduce((a, b) => Math.max(a, b), 0) || null,
      engine: ccs.length ? ccs.map((c) => `${c} cc`).join(" / ") : kwh.length ? kwh.map((k) => `${k} kWh`).join(" / ") : null,
      power: max("maxPowerPs") ? `${max("maxPowerPs")} PS` : null,
      torque: max("maxTorqueNm") ? `${max("maxTorqueNm")} Nm` : null,
      mileage: mileage || null,
      boot: max("bootLitres"),
      dims: specs.length ? { length: first("lengthMm"), width: first("widthMm"), height: first("heightMm"), wheelbase: first("wheelbaseMm"), tank: n(first("fuelTankLitres")), frontSuspension: first("frontSuspension"), rearSuspension: first("rearSuspension") } : null,
      features: sorted.length
        ? { base: featureSet(sorted[0]), top: featureSet(sorted.at(-1)), baseTrim: sorted[0].name, topTrim: sorted.at(-1).name, ev: evSpec ? { batteryKwh: n(evSpec.batteryKwh), rangeKm: evSpec.claimedRangeKm ?? null, acKw: evSpec.extra?.acChargingKw ?? null, dcKw: evSpec.extra?.dcChargingKw ?? null, fastChargeMinutes: evSpec.extra?.fastChargeMinutes ?? null } : null }
        : null,
      colors: (bundle.colors ?? []).filter((c) => c.hex).map((c) => ({ name: c.name, hex: c.hex })),
    },
    variants,
    photos: (bundle.images ?? []).filter((i) => i.storedUrl && i.licenceStatus === "permitted").map((i) => ({ url: i.storedUrl, kind: photoKind(i.category), credit: i.attribution || i.sourceName, license: i.licence, page: i.sourceUrl })),
  };
}

async function findCmsCar(bundle) {
  const byId = await one("SELECT c.*, b.slug AS brand_slug FROM cars c JOIN brands b ON b.id = c.brand_id WHERE c.source->>'scraperModelId' = $1", [bundle.id]);
  if (byId) return byId;
  const bySlug = await one("SELECT c.*, b.slug AS brand_slug FROM cars c JOIN brands b ON b.id = c.brand_id WHERE b.slug = $1 AND c.slug = $2", [bundle.brand.slug, bundle.slug]);
  if (bySlug) return bySlug;
  const vw = bundle.externalIds?.variantwise;
  return vw ? one("SELECT c.*, b.slug AS brand_slug FROM cars c JOIN brands b ON b.id = c.brand_id WHERE c.source->>'vwId' = $1", [vw]) : null;
}

const fmt = (v) => (v === null || v === undefined ? "—" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? "(details)" : String(v));

/** What importing this record would do, without doing it. */
export async function planImport(recordId) {
  const { record, entity } = await scraper(`/approved/${recordId}`);
  if (record.entityType === "model") {
    const car = await findCmsCar(entity);
    const mapped = mapModel(entity);
    if (!car) return { record, entity, action: "create", car: null, mapped, changes: [], newPhotos: mapped.photos.length };
    const changes = [];
    for (const [k, v] of Object.entries(mapped.fields)) {
      if (v === null || k === "colors" || k === "features" || k === "dims") continue;
      const was = car[k];
      if (fmt(was) !== fmt(v) && !(typeof v === "number" && Number(was) === v)) changes.push({ field: k, from: fmt(was), to: fmt(v) });
    }
    const vCount = (await one("SELECT count(*)::int AS n FROM variants WHERE car_id = $1", [car.id])).n;
    if (vCount !== mapped.variants.length) changes.push({ field: "variants", from: `${vCount} variants`, to: `${mapped.variants.length} variants` });
    if (mapped.fields.features && JSON.stringify(car.features) !== JSON.stringify(mapped.fields.features)) changes.push({ field: "features", from: car.features ? "present" : "—", to: "updated per trim" });
    const pages = new Set((await rows("SELECT page FROM photos WHERE car_id = $1", [car.id])).map((p) => p.page));
    const newPhotos = mapped.photos.filter((p) => !pages.has(p.page)).length;
    return { record, entity, action: changes.length || newPhotos ? "update" : "skip", car, mapped, changes, newPhotos };
  }
  return { record, entity, action: "create", car: null, mapped: null, changes: [], newPhotos: 0 };
}

async function ensureBrand(c, brand) {
  const found = await c.query("SELECT id FROM brands WHERE slug = $1", [brand.slug]);
  if (found.rowCount) return found.rows[0].id;
  return (await c.query("INSERT INTO brands (slug, name, sort) VALUES ($1, $2, 100) RETURNING id", [brand.slug, brand.name])).rows[0].id;
}

async function copyPhotos(photos, prefix) {
  const out = [];
  for (const p of photos) {
    try {
      const img = await localizeImage(p.url, prefix);
      out.push({ ...p, src: img.src, w: img.w, h: img.h });
    } catch {
      // A photo that cannot be copied is left out; the rest still import.
    }
  }
  return out;
}

async function importModel(plan) {
  const { entity, mapped, car } = plan;
  const existingPages = car ? new Set((await rows("SELECT page FROM photos WHERE car_id = $1", [car.id])).map((p) => p.page)) : new Set();
  const photos = await copyPhotos(mapped.photos.filter((p) => !existingPages.has(p.page)), `${entity.brand.slug}-${entity.slug}`);
  const f = mapped.fields;
  return tx(async (c) => {
    let carId = car?.id;
    const source = { ...(car?.source ?? {}), name: car?.source?.name ?? "Automotive scraper", scraperModelId: entity.id, ...(entity.externalIds?.variantwise ? { vwId: entity.externalIds.variantwise } : {}), scraperImportedAt: new Date().toISOString() };
    if (!car) {
      const brandId = await ensureBrand(c, entity.brand);
      let slug = slugify(entity.slug || entity.name);
      if ((await c.query("SELECT 1 FROM cars WHERE brand_id = $1 AND slug = $2", [brandId, slug])).rowCount) slug = `${slug}-${entity.id.slice(0, 6)}`;
      const r = await c.query(
        `INSERT INTO cars (brand_id, slug, name, body, status, published, fuels, auto, seats, min_price, max_price, mileage, engine, power, torque, boot, popularity, dims, features, colors, source)
         VALUES ($1,$2,$3,$4,$5,false,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,40,$16,$17,$18,$19) RETURNING id`,
        [brandId, slug, entity.name, cmsBody(entity), ["upcoming", "announced"].includes(entity.status) ? "upcoming" : "on-sale", f.fuels ?? ["Petrol"], f.auto, f.seats ?? 5, f.min_price ?? 0, f.max_price ?? 0, f.mileage ?? "", f.engine ?? "", f.power ?? "", f.torque ?? "", f.boot ?? 0, f.dims, f.features, JSON.stringify(f.colors), source],
      );
      carId = r.rows[0].id;
    } else {
      // Only facts the scraper actually has are written; everything else stays as the CMS has it.
      await c.query(
        `UPDATE cars SET min_price = COALESCE($2, min_price), max_price = COALESCE($3, max_price), fuels = COALESCE($4, fuels), auto = $5, seats = COALESCE($6, seats),
           engine = COALESCE($7, engine), power = COALESCE($8, power), torque = COALESCE($9, torque), mileage = COALESCE($10, mileage), boot = COALESCE($11, boot),
           dims = COALESCE($12, dims), features = COALESCE($13, features), colors = CASE WHEN jsonb_array_length(colors) = 0 AND jsonb_array_length($14::jsonb) > 0 THEN $14::jsonb ELSE colors END,
           source = $15, updated_at = now() WHERE id = $1`,
        [carId, f.min_price, f.max_price, f.fuels, f.auto, f.seats, f.engine, f.power, f.torque, f.mileage, f.boot, f.dims, f.features, JSON.stringify(f.colors), source],
      );
    }
    if (mapped.variants.length) {
      await c.query("DELETE FROM variants WHERE car_id = $1", [carId]);
      for (const v of mapped.variants) {
        await c.query("INSERT INTO variants (car_id, slug, name, fuel, trans, price, highlights, sort, source_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (car_id, slug) DO NOTHING", [carId, v.slug, v.name, v.fuel, v.trans, v.price, v.highlights, v.sort, v.source_url]);
      }
    }
    const start = (await c.query("SELECT COALESCE(max(sort), -1) + 1 AS n FROM photos WHERE car_id = $1", [carId])).rows[0].n;
    for (const [i, p] of photos.entries()) {
      await c.query("INSERT INTO photos (car_id, src, w, h, kind, credit, license, page, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [carId, p.src, p.w, p.h, p.kind, p.credit, p.license, p.page, start + i]);
    }
    return { cmsEntity: "cars", cmsId: carId, photos: photos.length, variants: mapped.variants.length };
  });
}

async function importNews(entity) {
  const car = entity.model ? await one("SELECT c.id FROM cars c JOIN brands b ON b.id = c.brand_id WHERE b.slug = $1 AND c.slug = $2", [entity.brand?.slug, entity.model.slug]) : null;
  const r = await one(
    "INSERT INTO news_leads (url, title, source, published_at, summary, car_id, is_launch) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (url) DO UPDATE SET title = EXCLUDED.title RETURNING id",
    [entity.sourceUrl, entity.title.slice(0, 300), entity.sourceName, entity.publishedAt, entity.description ?? "", car?.id ?? null, /\b(launch(ed|es)?|unveil(ed|s)?|debut)/i.test(entity.title)],
  );
  return { cmsEntity: "news_leads", cmsId: r.id };
}

async function importBrand(entity) {
  const r = await tx(async (c) => {
    const id = await ensureBrand(c, entity);
    if (entity.description) await c.query("UPDATE brands SET description = $2 WHERE id = $1 AND description = ''", [id, entity.description]);
    return id;
  });
  return { cmsEntity: "brands", cmsId: r };
}

async function importImage(entity) {
  if (!entity.storedUrl) throw new Error("Only images stored with reuse rights can be imported (this one is a link only).");
  const car = await findCmsCar({ id: entity.modelId, brand: entity.model.brand, slug: entity.model.slug, externalIds: entity.model.externalIds });
  if (!car) throw new Error(`Import the car ${entity.model.brand.name} ${entity.model.name} first.`);
  if (await one("SELECT 1 FROM photos WHERE car_id = $1 AND page = $2", [car.id, entity.sourceUrl])) return { cmsEntity: "photos", cmsId: "exists" };
  const img = await localizeImage(entity.storedUrl, `${entity.model.brand.slug}-${entity.model.slug}`);
  const sort = (await one("SELECT COALESCE(max(sort), -1) + 1 AS n FROM photos WHERE car_id = $1", [car.id])).n;
  const r = await one("INSERT INTO photos (car_id, src, w, h, kind, credit, license, page, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id", [car.id, img.src, img.w, img.h, photoKind(entity.category), entity.attribution || entity.sourceName, entity.licence, entity.sourceUrl, sort]);
  return { cmsEntity: "photos", cmsId: r.id };
}

/**
 * Imports one approved record. An update to an existing car needs confirm=true;
 * without it the diff is saved as "awaiting confirmation" and nothing changes.
 */
export async function importRecord(req, recordId, { confirm = false } = {}) {
  const userId = req?.session?.user?.id ?? null;
  let plan;
  try {
    plan = await planImport(recordId);
  } catch (err) {
    await query("INSERT INTO scraper_imports (record_id, entity_type, title, action, status, error, user_id) VALUES ($1,'unknown',$2,'create','failed',$3,$4)", [recordId, recordId, err.message, userId]);
    throw err;
  }
  const { record } = plan;
  const diff = { changes: plan.changes, newPhotos: plan.newPhotos, car: plan.car ? { id: plan.car.id, name: plan.car.name, published: plan.car.published } : null };
  if (plan.action === "skip") {
    await query("INSERT INTO scraper_imports (record_id, entity_type, title, action, status, cms_entity, cms_id, diff, user_id) VALUES ($1,$2,$3,'skip','done','cars',$4,$5,$6)", [recordId, record.entityType, record.title, String(plan.car.id), diff, userId]);
    await scraper(`/approved/${recordId}/imported`, { method: "POST", body: { cmsRef: `cars:${plan.car.id}` } });
    return { status: "done", action: "skip", message: "Nothing to change: the CMS car already matches." };
  }
  if (plan.action === "update" && !confirm) {
    await query("DELETE FROM scraper_imports WHERE record_id = $1 AND status = 'awaiting_confirmation'", [recordId]);
    const row = await one("INSERT INTO scraper_imports (record_id, entity_type, title, action, status, cms_entity, cms_id, diff, user_id) VALUES ($1,$2,$3,'update','awaiting_confirmation','cars',$4,$5,$6) RETURNING id", [recordId, record.entityType, record.title, String(plan.car.id), diff, userId]);
    return { status: "awaiting_confirmation", importId: row.id, plan };
  }
  try {
    const result =
      record.entityType === "model" ? await importModel(plan) : record.entityType === "news" ? await importNews(plan.entity) : record.entityType === "brand" ? await importBrand(plan.entity) : record.entityType === "image" ? await importImage(plan.entity) : null;
    if (!result) throw new Error(`Records of type ${record.entityType} cannot be imported`);
    await query("DELETE FROM scraper_imports WHERE record_id = $1 AND status IN ('awaiting_confirmation', 'failed')", [recordId]);
    await query("INSERT INTO scraper_imports (record_id, entity_type, title, action, status, cms_entity, cms_id, diff, user_id) VALUES ($1,$2,$3,$4,'done',$5,$6,$7,$8)", [recordId, record.entityType, record.title, plan.action, result.cmsEntity, String(result.cmsId), diff, userId]);
    await scraper(`/approved/${recordId}/imported`, { method: "POST", body: { cmsRef: `${result.cmsEntity}:${result.cmsId}` } }).catch(() => {});
    await audit(req, `scraper-${plan.action}`, result.cmsEntity, result.cmsId, record.title);
    await contentChanged();
    return { status: "done", action: plan.action, result };
  } catch (err) {
    await query("INSERT INTO scraper_imports (record_id, entity_type, title, action, status, diff, error, user_id) VALUES ($1,$2,$3,$4,'failed',$5,$6,$7)", [recordId, record.entityType, record.title, plan.action, diff, err.message, userId]);
    await scraper(`/approved/${recordId}/import-failed`, { method: "POST", body: { error: err.message } }).catch(() => {});
    throw err;
  }
}
