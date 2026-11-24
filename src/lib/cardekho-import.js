// CarScrapper tab: saves the scraped JSONL files into the CMS database (cardekho_* tables) and copies the
// pictures into the Media library. Nothing here touches the website catalogue (cars, variants, photos).
import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import sharp from "sharp";
import { config } from "../config.js";
import { one, query, rows, tx } from "../db.js";
import { slugify } from "./text.js";

export const DATA_FILES = {
  upcoming: { file: "upcoming.jsonl", kind: "upcoming", type: "car", label: "Upcoming cars" },
  cars: { file: "cars.jsonl", kind: "launched", type: "car", label: "Launched cars" },
  upcoming_variants: { file: "upcoming_variants.jsonl", kind: "upcoming", type: "variant", label: "Variants of upcoming cars" },
  variants: { file: "variants.jsonl", kind: "launched", type: "variant", label: "Variants of launched cars" },
};
// Upcoming first, so a car that has since launched ends up as "launched".
// A row counts as changed only when its data differs apart from the scrape time (scraped_at then shows the last change).
const ORDER = ["upcoming", "cars", "upcoming_variants", "variants"];

export const PHOTO_CREDIT = "CarDekho";
export const PHOTO_LICENSE = "Copyright CarDekho / the manufacturer. Imported for internal use; check the rights before publishing.";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const BATCH = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const toInt = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  const m = /^\s*(\d+)\s*$/.exec(String(v ?? ""));
  return m ? Number(m[1]) : null;
};
const toText = (v) => (v === null || v === undefined || v === "" ? null : String(v));
// scrape.py writes India time without a zone.
export const toTime = (v) => (v ? (/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}+05:30`) : null);

async function* readJsonl(file) {
  const lines = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // a half-written last line from a stopped run
    }
  }
}

/** Columns for one car record. */
export function carRow(r, kind) {
  return [
    r.slug, kind, toText(r.brand) ?? "", toText(r.model) ?? "", toText(r.name) ?? "", toText(r.status), toText(r.expected_launch), toText(r.price_range),
    toInt(r.ex_showroom_min), toInt(r.ex_showroom_max), toText(r.body_type), toText(r.fuel), toText(r.transmission), toInt(r.seats), toInt(r.airbags),
    toText(r.range_km), toText(r.battery), toText(r.mileage), (r.variants ?? []).length, toText(r.main_image), toText(r.description), toText(r.latest_update),
    toText(r.url), JSON.stringify(r), toTime(r.scraped_at),
  ];
}

/** Columns for one variant record. */
export function variantRow(r, kind) {
  return [
    r.url, r.car_slug, kind, toText(r.brand) ?? "", toText(r.model) ?? "", toText(r.variant) ?? "", toText(r.status), toText(r.tag), toText(r.fuel),
    toText(r.transmission), toText(r.price_text), toInt(r.ex_showroom), toInt(r.on_road), toText(r.engine_cc), toText(r.max_power), toText(r.max_torque),
    toInt(r.seats), toInt(r.airbags), toText(r.range_km), toText(r.battery), toText(r.mileage), JSON.stringify(r), toTime(r.scraped_at),
  ];
}

const CAR_SQL = `INSERT INTO cardekho_cars (slug, kind, brand, model, name, status, expected_launch, price_range, ex_showroom_min, ex_showroom_max, body_type, fuel,
  transmission, seats, airbags, range_km, battery, mileage, variants_count, main_image, description, latest_update, url, data, scraped_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
  ON CONFLICT (slug) DO UPDATE SET kind = EXCLUDED.kind, brand = EXCLUDED.brand, model = EXCLUDED.model, name = EXCLUDED.name, status = EXCLUDED.status,
    expected_launch = EXCLUDED.expected_launch, price_range = EXCLUDED.price_range, ex_showroom_min = EXCLUDED.ex_showroom_min, ex_showroom_max = EXCLUDED.ex_showroom_max,
    body_type = EXCLUDED.body_type, fuel = EXCLUDED.fuel, transmission = EXCLUDED.transmission, seats = EXCLUDED.seats, airbags = EXCLUDED.airbags,
    range_km = EXCLUDED.range_km, battery = EXCLUDED.battery, mileage = EXCLUDED.mileage, variants_count = EXCLUDED.variants_count, main_image = EXCLUDED.main_image,
    description = EXCLUDED.description, latest_update = EXCLUDED.latest_update, url = EXCLUDED.url, data = EXCLUDED.data, scraped_at = EXCLUDED.scraped_at, updated_at = now()
  WHERE (cardekho_cars.data - 'scraped_at') IS DISTINCT FROM (EXCLUDED.data - 'scraped_at')
    AND NOT (cardekho_cars.kind = 'launched' AND EXCLUDED.kind = 'upcoming')
  RETURNING (xmax = 0) AS inserted`;

const VARIANT_SQL = `INSERT INTO cardekho_variants (url, car_slug, kind, brand, model, variant, status, tag, fuel, transmission, price_text, ex_showroom, on_road,
  engine_cc, max_power, max_torque, seats, airbags, range_km, battery, mileage, data, scraped_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
  ON CONFLICT (url) DO UPDATE SET car_slug = EXCLUDED.car_slug, kind = EXCLUDED.kind, brand = EXCLUDED.brand, model = EXCLUDED.model, variant = EXCLUDED.variant,
    status = EXCLUDED.status, tag = EXCLUDED.tag, fuel = EXCLUDED.fuel, transmission = EXCLUDED.transmission, price_text = EXCLUDED.price_text,
    ex_showroom = EXCLUDED.ex_showroom, on_road = EXCLUDED.on_road, engine_cc = EXCLUDED.engine_cc, max_power = EXCLUDED.max_power, max_torque = EXCLUDED.max_torque,
    seats = EXCLUDED.seats, airbags = EXCLUDED.airbags, range_km = EXCLUDED.range_km, battery = EXCLUDED.battery, mileage = EXCLUDED.mileage, data = EXCLUDED.data,
    scraped_at = EXCLUDED.scraped_at, updated_at = now()
  WHERE (cardekho_variants.data - 'scraped_at') IS DISTINCT FROM (EXCLUDED.data - 'scraped_at')
    AND NOT (cardekho_variants.kind = 'launched' AND EXCLUDED.kind = 'upcoming')
  RETURNING (xmax = 0) AS inserted`;

const CAR_WATCH = [["price_range", "price"], ["status", "status"], ["expected_launch", "launch"], ["variants_count", "variants"], ["fuel", "fuel"], ["body_type", "body"]];
const VARIANT_WATCH = [["price_text", "price"], ["on_road", "on-road"], ["status", "status"], ["fuel", "fuel"], ["transmission", "gearbox"]];

/** "price 6 - 10 Lakh → 6.2 - 10 Lakh; variants 8 → 9", or "details" when only specs / features / pictures changed. */
export function describeChange(before, after, watch) {
  const parts = watch.filter(([k]) => String(before[k] ?? "") !== String(after[k] ?? "")).map(([k, label]) => `${label} ${before[k] ?? "—"} → ${after[k] ?? "—"}`);
  return parts.length ? parts.join("; ") : "details (specs, features or pictures)";
}

/** Saves the chosen data files into the database. ctx: { log, change, progress, stopped, summary }. */
export async function importData(ctx, dataDir, keys = ORDER) {
  const { existsSync } = await import("node:fs");
  const db = (ctx.summary.db ??= { NEW: 0, UPDATED: 0, SAME: 0 });
  for (const key of ORDER.filter((k) => keys.includes(k))) {
    if (ctx.stopped()) return;
    const spec = DATA_FILES[key];
    const file = path.join(dataDir, spec.file);
    if (!existsSync(file)) {
      ctx.log(`CMS DB: ${spec.file} not found, skipped (run that scrape first).`);
      continue;
    }
    const isCar = spec.type === "car";
    const before = new Map((await rows(isCar
      ? "SELECT slug AS key, name, price_range, status, expected_launch, variants_count, fuel, body_type FROM cardekho_cars"
      : "SELECT url AS key, model, variant, price_text, on_road, status, fuel, transmission FROM cardekho_variants")).map((r) => [r.key, r]));
    const recs = [];
    for await (const r of readJsonl(file)) if (isCar ? r.slug : r.url) recs.push(r);
    ctx.log(`CMS DB: saving ${recs.length} records from ${spec.file} …`);
    const tally = { NEW: 0, UPDATED: 0, SAME: 0 };
    for (let i = 0; i < recs.length; i += BATCH) {
      if (ctx.stopped()) break;
      const batch = recs.slice(i, i + BATCH);
      await tx(async (client) => {
        for (const r of batch) {
          const params = isCar ? carRow(r, spec.kind) : variantRow(r, spec.kind);
          const res = await client.query(isCar ? CAR_SQL : VARIANT_SQL, params);
          const name = isCar ? r.name : `${r.model} ${r.variant}`;
          if (!res.rowCount) tally.SAME += 1;
          else if (res.rows[0].inserted) {
            tally.NEW += 1;
            ctx.change(`NEW      ${name} | ${isCar ? r.price_range : r.price_text}`);
          } else {
            tally.UPDATED += 1;
            const after = isCar ? { price_range: r.price_range, status: r.status, expected_launch: r.expected_launch, variants_count: (r.variants ?? []).length, fuel: r.fuel, body_type: r.body_type }
              : { price_text: r.price_text, on_road: toInt(r.on_road), status: r.status, fuel: r.fuel, transmission: r.transmission };
            ctx.change(`UPDATED  ${name} | ${describeChange(before.get(isCar ? r.slug : r.url) ?? {}, after, isCar ? CAR_WATCH : VARIANT_WATCH)}`);
          }
        }
      });
      ctx.progress(Math.min(i + BATCH, recs.length), recs.length);
    }
    for (const k of Object.keys(tally)) db[k] += tally[k];
    ctx.log(`CMS DB: ${spec.label}: ${tally.NEW} new, ${tally.UPDATED} updated, ${tally.SAME} unchanged.`);
  }
}

// CarDekho serves each picture in a few fixed sizes; 930x620 is the largest (1280 and up answer 404).
export const HD_SIZE = "930x620";
/** ".../carexteriorimages/630x420/Tata/..." -> ".../carexteriorimages/930x620/Tata/..." (colour photos too). */
export const hdUrl = (u) => String(u).replace(/\/\d{3,4}x\d{3,4}\//, `/${HD_SIZE}/`);

/** Picture addresses of one saved car (largest size), with a short title for each. */
export function carPictures(rec) {
  const out = [];
  const seen = new Set();
  const add = (original, kind, title, group = null) => {
    if (!original || !/^https:\/\//.test(original)) return;
    const url = hdUrl(original);
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, original, kind, title, group, sort: out.length });
  };
  const titleOf = (u) => {
    try {
      return path.basename(new URL(u).pathname).replace(/\.\w+$/, "").replace(/-\d+$/, "").replace(/-/g, " ");
    } catch {
      return null; // not a usable address: skipped
    }
  };
  // The full gallery (model page, with a title per photo). A long caption is the source's own writing, so the
  // title then comes from the picture's file name instead ("rear-view-119.jpg" -> "rear view").
  for (const g of Array.isArray(rec.gallery) ? rec.gallery : []) {
    const title = String(g?.title ?? "").trim();
    if (g?.image) add(g.image, "picture", title && title.split(/\s+/).length <= 7 ? title : titleOf(g.image) ?? "photo", String(g.group ?? "").trim() || null);
  }
  // Older records can hold one address as a string, or an address split into single characters.
  let pics = rec.pictures ?? [];
  if (typeof pics === "string") pics = [pics];
  else if (Array.isArray(pics) && pics.length > 1 && pics.every((x) => typeof x === "string" && x.length === 1)) pics = [pics.join("")];
  for (const u of Array.isArray(pics) ? pics : []) {
    const title = typeof u === "string" ? titleOf(u) : null;
    if (title !== null) add(u, "picture", title);
  }
  for (const c of rec.colours ?? []) if (c?.image && titleOf(c.image) !== null) add(c.image, "colour", c.name ?? "colour");
  return out;
}

async function saveWebp(buffer, car, pic) {
  const dir = path.join(config.uploadDir, "cardekho", slugify(car.brand) || "brand");
  mkdirSync(dir, { recursive: true });
  const filename = `${slugify(`${car.slug.split("/")[1]}-${pic.title}`).slice(0, 70) || "photo"}-${Date.now().toString(36)}.webp`;
  const out = await sharp(buffer).rotate().resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 86, smartSubsample: true }).toFile(path.join(dir, filename));
  const url = `${config.cmsUrl}/uploads/cardekho/${path.basename(dir)}/${filename}`;
  const alt = `${car.name} ${pic.kind === "colour" ? `in ${pic.title}` : pic.title}`.trim();
  return one("INSERT INTO media (filename, url, w, h, bytes, alt, credit, license) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id", [filename, url, out.width, out.height, out.size, alt, PHOTO_CREDIT, PHOTO_LICENSE]);
}

async function download(url) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "image/avif,image/webp,image/*,*/*;q=0.8", referer: "https://www.cardekho.com/" }, signal: AbortSignal.timeout(30000) });
      if (res.status === 404) throw Object.assign(new Error("404 not found"), { final: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      last = err;
      if (err.final) break;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

/** The HD picture, or the size the page listed when HD is missing. */
async function downloadBest(pic) {
  try {
    return { buffer: await download(pic.url), hd: true };
  } catch (err) {
    if (!pic.original || pic.original === pic.url) throw err;
    return { buffer: await download(pic.original), hd: false };
  }
}

/**
 * Copies the pictures of the saved cars into the Media library in HD (930x620). Pictures already there in HD are
 * skipped; ones copied earlier at a smaller size are replaced by the HD version (new file name, so no cache serves
 * the old one; the old file is kept so cached pages never show a broken image); failed ones are tried again.
 */
/**
 * Adds what the --reviews scrape read from each model page (expert review and full photo gallery) to the saved
 * cars, so the photo import and the page copy can use it. Cars scraped again later carry these fields themselves.
 */
export async function importExtras(ctx, dataDir) {
  const file = path.join(dataDir, "reviews.jsonl");
  if (!existsSync(file)) return ctx.log("No reviews.jsonl yet: nothing to add.");
  let n = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r?.slug) continue;
    const extra = { pros: r.pros ?? [], cons: r.cons ?? [], verdict: r.verdict ?? null, review_sections: r.review_sections ?? [], gallery: r.gallery ?? [] };
    n += (await query("UPDATE cardekho_cars SET data = data || $2::jsonb WHERE slug = $1 AND NOT (data @> $2::jsonb)", [r.slug, JSON.stringify(extra)])).rowCount;
  }
  ctx.log(`Saved cars: gallery and expert review added to ${n} cars.`);
}

export async function importPhotos(ctx, { brand = null, limit = null, kind = null, slugs = null, delayMs = 250 } = {}) {
  const ph = (ctx.summary.photos ??= { done: 0, failed: 0, skipped: 0, upgraded: 0 });
  ph.upgraded ??= 0;
  const cars = await rows(`SELECT slug, brand, name, data FROM cardekho_cars WHERE ($1::text IS NULL OR slug LIKE $1 || '/%') AND ($2::text IS NULL OR kind = $2)
    AND ($3::text[] IS NULL OR slug = ANY($3)) ORDER BY kind, slug ${limit ? "LIMIT $4" : ""}`, limit ? [brand, kind, slugs, limit] : [brand, kind, slugs]);
  const existing = new Map((await rows("SELECT p.id, p.source_url, p.status, p.media_id, p.title, p.grp, p.sort, m.url AS media_url FROM cardekho_photos p LEFT JOIN media m ON m.id = p.media_id")).map((r) => [hdUrl(r.source_url.replace(/#kept$/, "")), r]));
  ctx.log(`Photos: ${cars.length} ${kind ? `${kind} ` : ""}cars to check${brand ? ` (brand ${brand})` : ""}; pictures are copied in HD (${HD_SIZE}).`);
  for (const [n, car] of cars.entries()) {
    if (ctx.stopped()) return;
    const pics = carPictures(car.data);
    const isDone = (p) => {
      const r = existing.get(p.url);
      return r?.status === "done" && r.media_id && (r.source_url === p.url || r.source_url === `${p.original}#kept`);
    };
    const todo = pics.filter((p) => !isDone(p));
    // Photos copied before: only their title, group and order are brought up to date (no new download).
    for (const p of pics.filter(isDone)) {
      const r = existing.get(p.url);
      if (r.id && (r.title !== p.title || (r.grp ?? null) !== p.group || r.sort !== p.sort)) {
        await query("UPDATE cardekho_photos SET title = $2, grp = $3, sort = $4 WHERE id = $1", [r.id, p.title, p.group, p.sort]);
        Object.assign(r, { title: p.title, grp: p.group, sort: p.sort });
      }
    }
    ph.skipped += pics.length - todo.length;
    let added = 0;
    let upgraded = 0;
    let bad = 0;
    for (const pic of todo) {
      if (ctx.stopped()) break;
      const old = existing.get(pic.url);
      const upgrade = old?.status === "done" && old.media_id;
      try {
        const got = await downloadBest(pic);
        if (upgrade && !got.hd) {
          // No HD version exists: keep the copy we have, and remember not to try again.
          await query("UPDATE cardekho_photos SET source_url = $2 WHERE id = $1", [old.id, `${pic.original}#kept`]);
          ph.skipped += 1;
          continue;
        }
        const media = await saveWebp(got.buffer, car, pic);
        const source = got.hd ? pic.url : `${pic.original}#kept`;
        if (upgrade) {
          await query("UPDATE cardekho_photos SET source_url = $2, media_id = $3, sort = $4, title = $5, grp = $6, error = NULL WHERE id = $1", [old.id, source, media.id, pic.sort, pic.title, pic.group]);
          // The old row leaves the Media library, but its file stays: pages the website has cached may still
          // point at it for a while, and a deleted file would show as a broken image there.
          await query("DELETE FROM media WHERE id = $1", [old.media_id]);
          upgraded += 1;
        } else {
          if (old) await query("DELETE FROM cardekho_photos WHERE id = $1", [old.id]);
          const row = await one(`INSERT INTO cardekho_photos (car_slug, source_url, kind, title, sort, media_id, status, error, grp) VALUES ($1,$2,$3,$4,$5,$6,'done',NULL,$7)
            ON CONFLICT (source_url) DO UPDATE SET media_id = EXCLUDED.media_id, status = 'done', error = NULL, car_slug = EXCLUDED.car_slug, sort = EXCLUDED.sort, title = EXCLUDED.title, grp = EXCLUDED.grp RETURNING id`,
          [car.slug, source, pic.kind, pic.title, pic.sort, media.id, pic.group]);
          existing.set(pic.url, { id: row.id, status: "done", media_id: media.id, source_url: source, title: pic.title, grp: pic.group, sort: pic.sort });
          added += 1;
        }
        if (upgrade) existing.set(pic.url, { ...old, status: "done", media_id: media.id, source_url: source, title: pic.title, grp: pic.group, sort: pic.sort });
      } catch (err) {
        if (!upgrade) {
          await one(`INSERT INTO cardekho_photos (car_slug, source_url, kind, title, sort, status, error) VALUES ($1,$2,$3,$4,$5,'failed',$6)
            ON CONFLICT (source_url) DO UPDATE SET status = CASE WHEN cardekho_photos.status = 'done' THEN 'done' ELSE 'failed' END, error = EXCLUDED.error RETURNING id`,
          [car.slug, pic.url, pic.kind, pic.title, pic.sort, String(err.message).slice(0, 300)]);
        }
        bad += 1;
      }
      await sleep(delayMs);
    }
    ph.done += added;
    ph.upgraded += upgraded;
    ph.failed += bad;
    ctx.progress(n + 1, cars.length);
    if (added || upgraded || bad) {
      const parts = [added && `${added} new`, upgraded && `${upgraded} replaced by HD`, bad && `${bad} failed`].filter(Boolean).join(", ");
      ctx.log(`[${n + 1}/${cars.length}] ${car.name}: ${parts}${pics.length - todo.length ? `, ${pics.length - todo.length} already HD` : ""}`);
      if (added || upgraded) ctx.change(`PHOTOS   ${car.name} | ${parts} (HD ${HD_SIZE})`);
      // Put the car on the website as soon as its photos are in, rather than after every car is done.
      if ((added || upgraded) && ctx.onCarPhotos) await ctx.onCarPhotos(car.slug);
    }
  }
  ctx.log(`Photos: ${ph.done} new, ${ph.upgraded} replaced by HD, ${ph.failed} failed, ${ph.skipped} already in the Media library.`);
}

/** Saves city_prices.jsonl (on-road price of every variant per city) into cardekho_city_prices. */
export async function importCityPrices(ctx, dataDir) {
  const { existsSync } = await import("node:fs");
  const file = path.join(dataDir, "city_prices.jsonl");
  if (!existsSync(file)) {
    ctx.log("CMS DB: city_prices.jsonl not found, skipped (run On-road prices by city first).");
    return;
  }
  const recs = [];
  for await (const r of readJsonl(file)) if (r.key && r.slug && r.city) recs.push(r);
  const db = (ctx.summary.db ??= { NEW: 0, UPDATED: 0, SAME: 0 });
  const tally = { NEW: 0, UPDATED: 0, SAME: 0 };
  for (let i = 0; i < recs.length; i += BATCH) {
    await tx(async (client) => {
      for (const r of recs.slice(i, i + BATCH)) {
        const data = { variants: r.variants ?? [], base_breakup: r.base_breakup ?? null, city_name: r.city_name, city_id: r.city_id };
        const res = await client.query(
          `INSERT INTO cardekho_city_prices (key, car_slug, city_slug, data, scraped_at) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, scraped_at = EXCLUDED.scraped_at, updated_at = now()
           WHERE cardekho_city_prices.data IS DISTINCT FROM EXCLUDED.data RETURNING (xmax = 0) AS inserted`,
          [r.key, r.slug, r.city, JSON.stringify(data), toTime(r.scraped_at)],
        );
        tally[!res.rowCount ? "SAME" : res.rows[0].inserted ? "NEW" : "UPDATED"] += 1;
      }
    });
    ctx.progress(Math.min(i + BATCH, recs.length), recs.length);
  }
  for (const k of Object.keys(tally)) db[k] += tally[k];
  ctx.log(`CMS DB: on-road prices by city: ${tally.NEW} new, ${tally.UPDATED} updated, ${tally.SAME} unchanged (${recs.length} car-city pages).`);
}
