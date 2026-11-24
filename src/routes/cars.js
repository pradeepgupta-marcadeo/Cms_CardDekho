import { Router } from "express";
import { getSetting, one, query, rows, tx } from "../db.js";
import { aiStatus } from "../lib/ai.js";
import { tagCarPhotos } from "../lib/car-photos.js";
import { runCarCollector } from "../lib/car-collector.js";
import { scraper } from "../lib/scraper-client.js";
import { searchCommons } from "../importers/commons.js";
import { carKeywords } from "../lib/keywords.js";
import { draftLaunch, draftReview, writeCarPageCopy } from "../lib/drafts.js";
import { audit, contentChanged } from "../lib/publish.js";
import { localizeImage } from "../lib/localize.js";
import { addRedirect } from "../lib/redirects.js";
import { sectionsFromText, sectionsToText, slugify, toList } from "../lib/text.js";
import { friendly } from "./crud.js";

export const carsRouter = Router();

const BODIES = ["SUV", "Hatchback", "Sedan", "MUV", "Luxury"];
const FUELS = ["Petrol", "Diesel", "CNG", "Electric", "Hybrid"];
const STATUSES = ["on-sale", "new-launch", "upcoming"];

const getCar = (id) => one("SELECT c.*, b.slug AS brand_slug, b.name AS brand_name FROM cars c JOIN brands b ON b.id = c.brand_id WHERE c.id = $1", [id]);
export const carPath = (c) => `/cars/${c.brand_slug}/${c.slug}`;

const lines = (t) => String(t ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const faqsToText = (faqs) => (faqs ?? []).map((f) => `Q: ${f.q}\nA: ${f.a}`).join("\n\n");
const faqsFromText = (t) =>
  String(t ?? "")
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((b) => {
      const q = b.match(/^Q:\s*(.+)$/m)?.[1]?.trim();
      const a = b.match(/^A:\s*([\s\S]+)$/m)?.[1]?.trim().replace(/\n/g, " ");
      return q && a ? { q, a } : null;
    })
    .filter(Boolean);
// One colour per line: "Name | #HEX | extra price in rupees". The price is optional and may be negative
// ("+15000", "-5000"); it is the difference from the car's listed price when this colour is chosen.
const colorsToText = (c) => (c ?? []).map((x) => [x.name, x.hex, Number.isInteger(x.price) ? (x.price > 0 ? `+${x.price}` : String(x.price)) : ""].filter((v, i) => i < 2 || v !== "").join(" | ")).join("\n");
const colorsFromText = (t) =>
  String(t ?? "")
    .split(/\n/)
    .map((l) => l.split("|").map((s) => s.trim()))
    .filter(([n, h]) => n && /^#[0-9a-f]{6}$/i.test(h ?? ""))
    .map(([name, hex, price]) => ({ name, hex: hex.toUpperCase(), ...(/^[+-]?\d{1,7}$/.test(price ?? "") ? { price: Number(price) } : {}) }));

const CAR_SORTS = { name: "b.name, c.name", price: "c.min_price", popularity: "c.popularity", updated: "c.updated_at", photos: "photos" };

carsRouter.get("/", async (req, res) => {
  const filter = ["all", "live", "hidden", "upcoming", "nocopy"].includes(req.query.filter) ? req.query.filter : "all";
  const q = String(req.query.q ?? "").trim();
  const body = BODIES.includes(req.query.body) ? req.query.body : "";
  const brand = String(req.query.brand ?? "").trim();
  const source = String(req.query.source ?? "").trim();
  const per = [25, 50, 100, 200].includes(Number(req.query.limit)) ? Number(req.query.limit) : 25;
  const page = Math.max(1, Number(req.query.page) || 1);
  const sortKey = String(req.query.sort ?? "-popularity");
  const sortCol = CAR_SORTS[sortKey.replace(/^-/, "")] ? sortKey.replace(/^-/, "") : "popularity";
  const desc = sortKey.startsWith("-");
  const where = [];
  const params = [];
  if (q) where.push(`(c.name ILIKE $${params.push(`%${q}%`)} OR b.name ILIKE $${params.length})`);
  if (body) where.push(`c.body = $${params.push(body)}`);
  if (brand) where.push(`b.slug = $${params.push(brand)}`);
  if (source === "manual") where.push("(c.source IS NULL OR c.source->>'name' IS NULL)");
  else if (source) where.push(`c.source->>'name' = $${params.push(source)}`);
  if (filter === "live") where.push("c.published AND EXISTS (SELECT 1 FROM photos p WHERE p.car_id = c.id)");
  if (filter === "hidden") where.push("(NOT c.published OR NOT EXISTS (SELECT 1 FROM photos p WHERE p.car_id = c.id))");
  if (filter === "upcoming") where.push("c.status = 'upcoming'");
  if (filter === "nocopy") where.push("jsonb_array_length(c.overview) = 0");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const matched = (await one(`SELECT count(*)::int AS n FROM cars c JOIN brands b ON b.id = c.brand_id ${clause}`, params)).n;
  const list = await rows(
    `SELECT c.id, c.name, c.slug, c.status, c.published, c.min_price, c.max_price, c.popularity, c.updated_at, b.name AS brand, b.slug AS brand_slug,
       (SELECT count(*)::int FROM photos p WHERE p.car_id = c.id) AS photos,
       (SELECT count(*)::int FROM variants v WHERE v.car_id = c.id) AS variants,
       (SELECT src FROM photos p WHERE p.car_id = c.id ORDER BY sort, id LIMIT 1) AS thumb,
       jsonb_array_length(c.overview) AS copy, c.source
     FROM cars c JOIN brands b ON b.id = c.brand_id ${clause}
     ORDER BY ${sortCol === "name" ? "b.name, c.name" : CAR_SORTS[sortCol]} ${desc ? "DESC" : "ASC"} NULLS LAST, c.id LIMIT ${per} OFFSET ${(page - 1) * per}`,
    params,
  );
  const totals = await one(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE published AND EXISTS (SELECT 1 FROM photos p WHERE p.car_id = cars.id))::int AS live,
      count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM photos p WHERE p.car_id = cars.id))::int AS nophoto,
      count(*) FILTER (WHERE status = 'upcoming')::int AS upcoming FROM cars`);
  const brands = await rows("SELECT slug, name FROM brands ORDER BY name");
  const sources = await rows("SELECT DISTINCT source->>'name' AS name FROM cars WHERE source->>'name' IS NOT NULL ORDER BY 1");
  const pending = await scraper("/dashboard", { timeout: 4000 }).then((d) => d.records.pending).catch(() => null);
  res.render("cars", { title: "Cars", list, filter, q, body, brand, source, per, page, sort: sortKey, matched, totals, brands, sources: sources.map((s) => s.name), BODIES, pending, ai: aiStatus().some((p) => p.configured) });
});

// The "Run collector" button: collect, approve, import, find photos, show, write guides. Streams one line per step.
carsRouter.post("/collect", async (req, res) => {
  const b = { ...req.query, ...req.body };
  res.status(200);
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store, no-transform");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();
  let stopped = false;
  res.on("close", () => {
    if (!res.writableFinished) stopped = true;
  });
  const log = (line) => {
    if (res.writableEnded || stopped) return;
    res.write(`${line}\n`);
    res.flush?.();
  };
  try {
    const auto = await getSetting("auto_cars", { confirmUpdates: true });
    await runCarCollector({ collect: b.collect !== "0", photoCars: b.photoCars, photosPerCar: b.photosPerCar, aiOverviews: b.aiOverviews, confirmUpdates: auto.confirmUpdates !== false, log, stopped: () => stopped });
    await audit(req, "collect", "cars", null, "car collector run from the CMS");
  } catch (err) {
    log(`ERROR  ${err.message}`);
  }
  res.end();
});

// Show or hide one car (a car needs a photo to be visible, whatever this says).
carsRouter.post("/:id/visibility", async (req, res) => {
  const c = await one("UPDATE cars SET published = NOT published, updated_at = now() WHERE id = $1 RETURNING id, name, published", [req.params.id]);
  if (c) {
    await audit(req, c.published ? "show" : "hide", "cars", c.id, c.name);
    await contentChanged();
    req.session.flash = { type: "ok", text: c.published ? `${c.name} is set to show on the website (it needs a photo to appear).` : `${c.name} is hidden from the website.` };
  }
  res.redirect(req.get("referer") || "/admin/cars");
});

carsRouter.post("/bulk", async (req, res) => {
  const ids = [...new Set([].concat(req.body.ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const show = req.body.action === "show";
  if (!ids.length || !["show", "hide"].includes(req.body.action)) {
    req.session.flash = { type: "err", text: "Select at least one car first." };
    return res.redirect(req.get("referer") || "/admin/cars");
  }
  await query("UPDATE cars SET published = $2, updated_at = now() WHERE id = ANY($1)", [ids, show]);
  await audit(req, show ? "show" : "hide", "cars", null, `${ids.length} cars`);
  await contentChanged();
  req.session.flash = { type: "ok", text: `${ids.length} cars ${show ? "set to show on the website (those with a photo appear)" : "hidden"}.` };
  res.redirect(req.get("referer") || "/admin/cars");
});


carsRouter.get("/new", async (req, res) => {
  res.render("car-new", { title: "Add a car", brands: await rows("SELECT id, name FROM brands ORDER BY name"), prefill: String(req.query.name ?? ""), error: null });
});

carsRouter.post("/new", async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  let brandId = Number(req.body.brand_id) || null;
  const newBrand = String(req.body.new_brand ?? "").trim();
  if (!name || (!brandId && !newBrand)) {
    return res.status(400).render("car-new", { title: "Add a car", brands: await rows("SELECT id, name FROM brands ORDER BY name"), prefill: name, error: "Enter the model name and choose a brand (or type a new brand)." });
  }
  try {
    const id = await tx(async (c) => {
      if (!brandId) brandId = (await c.query("INSERT INTO brands (slug, name, sort) VALUES ($1,$2,100) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id", [slugify(newBrand), newBrand])).rows[0].id;
      const r = await c.query("INSERT INTO cars (brand_id, slug, name, status, published, fuels) VALUES ($1,$2,$3,$4,false,'{Petrol}') RETURNING id", [brandId, slugify(name), name, STATUSES.includes(req.body.status) ? req.body.status : "upcoming"]);
      return r.rows[0].id;
    });
    await audit(req, "create", "cars", id, name);
    req.session.flash = { type: "info", text: "Car created as hidden. Fill in the details, add at least one photo, then tick 'Show on website'." };
    res.redirect(`/admin/cars/${id}`);
  } catch (err) {
    res.status(400).render("car-new", { title: "Add a car", brands: await rows("SELECT id, name FROM brands ORDER BY name"), prefill: name, error: friendly(err) });
  }
});

carsRouter.get("/:id", async (req, res, next) => {
  const car = await getCar(req.params.id);
  if (!car) return next();
  const counts = await one("SELECT (SELECT count(*)::int FROM photos WHERE car_id = $1) AS photos, (SELECT count(*)::int FROM variants WHERE car_id = $1) AS variants, (SELECT count(*)::int FROM articles WHERE car_id = $1) AS articles", [car.id]);
  const keywords = await rows("SELECT phrase, priority, target_path FROM keywords WHERE target_path = $1 OR target_path LIKE $2 ORDER BY priority, phrase LIMIT 80", [carPath(car), `${carPath(car)}/%`]);
  res.render("car-edit", {
    title: `${car.brand_name} ${car.name}`,
    car,
    counts,
    keywords,
    brands: await rows("SELECT id, name FROM brands ORDER BY name"),
    text: { overview: sectionsToText(car.overview), faqs: faqsToText(car.faqs), colors: colorsToText(car.colors), pros: (car.pros ?? []).join("\n"), cons: (car.cons ?? []).join("\n") },
    BODIES,
    FUELS,
    STATUSES,
    errors: [],
  });
});

carsRouter.post("/:id", async (req, res, next) => {
  const car = await getCar(req.params.id);
  if (!car) return next();
  const b = req.body;
  const num = (v, d = 0) => (v === "" || v === undefined ? d : Number(v));
  const fuels = FUELS.filter((f) => b[`fuel_${f}`] === "on");
  const errors = [];
  if (!b.name?.trim()) errors.push("Model name is required.");
  if (!fuels.length) errors.push("Tick at least one fuel.");
  if (num(b.max_price) < num(b.min_price)) errors.push("Top price cannot be lower than the starting price.");
  const photoCount = (await one("SELECT count(*)::int AS n FROM photos WHERE car_id = $1", [car.id])).n;
  const published = b.published === "on";
  if (published && !photoCount) errors.push("Add at least one photo before showing this car on the website (Photos tab).");
  if (published && !(num(b.min_price) > 0)) errors.push("Enter the starting price (for an upcoming car, the expected price) before showing it on the website.");
  let model3d = null;
  if (b.m3d_uid?.trim()) model3d = { uid: b.m3d_uid.trim(), name: b.m3d_name?.trim() ?? "", author: b.m3d_author?.trim() ?? "", license: b.m3d_license?.trim() ?? "", url: b.m3d_url?.trim() || `https://sketchfab.com/3d-models/${b.m3d_uid.trim()}` };
  if (errors.length) {
    req.session.flash = { type: "err", text: errors.join(" ") };
    return res.redirect(`/admin/cars/${car.id}`);
  }
  const slug = slugify(b.slug || b.name);
  const source = car.source ?? {};
  if (b.vw_id !== undefined) source.vwId = b.vw_id.trim() || undefined;
  try {
    await query(
      `UPDATE cars SET brand_id=$2, name=$3, slug=$4, body=$5, status=$6, published=$7, launch=$8, fuels=$9, auto=$10, seats=$11, min_price=$12, max_price=$13,
        mileage=$14, engine=$15, power=$16, torque=$17, boot=$18, ncap=$19, rating=$20, reviews=$21, popularity=$22, angle=$23, pros=$24, cons=$25,
        colors=$26, overview=$27, faqs=$28, model3d=$29, source=$30, updated_at=now() WHERE id=$1`,
      [car.id, Number(b.brand_id), b.name.trim(), slug, BODIES.includes(b.body) ? b.body : "SUV", STATUSES.includes(b.status) ? b.status : "on-sale", published, b.launch?.trim() || null, fuels, b.auto === "on", num(b.seats, 5), num(b.min_price), num(b.max_price),
        b.mileage?.trim() ?? "", b.engine?.trim() ?? "", b.power?.trim() ?? "", b.torque?.trim() ?? "", num(b.boot), num(b.ncap), num(b.rating), num(b.reviews), num(b.popularity, 50), (b.angle ?? "").trim().replace(/^the\s+/i, ""), lines(b.pros), lines(b.cons),
        JSON.stringify(colorsFromText(b.colors)), JSON.stringify(sectionsFromText(b.overview)), JSON.stringify(faqsFromText(b.faqs)), model3d ? JSON.stringify(model3d) : null, JSON.stringify(source)],
    );
    if (slug !== car.slug && car.published) {
      const brand = await one("SELECT slug FROM brands WHERE id = $1", [Number(b.brand_id)]);
      await addRedirect(carPath(car), `/cars/${brand.slug}/${slug}`);
    }
    await audit(req, "update", "cars", car.id, `${car.brand_name} ${b.name}`);
    await contentChanged();
    let note = "";
    if (b.launch_draft === "on" && car.status === "upcoming" && b.status !== "upcoming") {
      try {
        const aid = await draftLaunch(req, car.id);
        note = ` A launch news draft is ready: /admin/articles/${aid}`;
      } catch (err) {
        note = ` (Launch news draft failed: ${err.message})`;
      }
    }
    req.session.flash = { type: "ok", text: `Saved. The website updates in a few seconds.${slug !== car.slug && car.published ? " The old URL now redirects to the new one." : ""}${note}` };
  } catch (err) {
    req.session.flash = { type: "err", text: friendly(err) };
  }
  res.redirect(`/admin/cars/${car.id}`);
});

carsRouter.post("/:id/delete", async (req, res) => {
  const car = await getCar(req.params.id);
  if (car) {
    if (car.published) await addRedirect(carPath(car), `/brands/${car.brand_slug}`, { onlyIfMissing: true });
    await query("DELETE FROM cars WHERE id = $1", [car.id]);
    await audit(req, "delete", "cars", car.id, `${car.brand_name} ${car.name}`);
    await contentChanged();
    req.session.flash = { type: "ok", text: `Deleted ${car.brand_name} ${car.name}.${car.published ? " Its old URL now redirects to the brand page." : ""}` };
  }
  res.redirect("/admin/cars");
});

// ---- Photos ----
carsRouter.get("/:id/photos", async (req, res, next) => {
  const car = await getCar(req.params.id);
  if (!car) return next();
  const photos = await rows("SELECT * FROM photos WHERE car_id = $1 ORDER BY sort, id", [car.id]);
  const term = String(req.query.q ?? `${car.brand_name} ${car.name}`);
  let results = [];
  let searchError = null;
  if (req.query.search) {
    try {
      const have = new Set(photos.map((p) => p.page));
      results = (await searchCommons(term)).filter((r) => !have.has(r.page));
    } catch (err) {
      searchError = err.message;
    }
  }
  res.render("car-photos", { title: `Photos: ${car.brand_name} ${car.name}`, car, photos, results, term, searched: Boolean(req.query.search), searchError });
});

carsRouter.post("/:id/photos", async (req, res) => {
  const b = req.body;
  const next = (await one("SELECT COALESCE(max(sort), -1) + 1 AS n FROM photos WHERE car_id = $1", [req.params.id])).n;
  if (!b.src || !Number(b.w) || !Number(b.h)) {
    req.session.flash = { type: "err", text: "Photo needs an image address and its width and height." };
    return res.redirect(`/admin/cars/${req.params.id}/photos`);
  }
  // Keep our own compressed copy (faster pages); fall back to the original address if the copy fails.
  let img = { src: b.src, w: Number(b.w), h: Number(b.h) };
  try {
    img = await localizeImage(b.src, `car-${req.params.id}-${b.kind || "front"}`);
  } catch {
    // keep the remote address
  }
  await query("INSERT INTO photos (car_id, src, w, h, kind, credit, license, page, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [req.params.id, img.src, img.w, img.h, b.kind || "front", b.credit ?? "", b.license ?? "", b.page ?? "", next]);
  await audit(req, "add-photo", "cars", req.params.id, b.page ?? b.src);
  await contentChanged();
  req.session.flash = { type: "ok", text: "Photo added." };
  res.redirect(`/admin/cars/${req.params.id}/photos${b.back_search ? `?search=1&q=${encodeURIComponent(b.back_search)}` : ""}`);
});

// Reads the words and pixels of every untagged exterior photo and sets the colour where it is clear.
carsRouter.post("/:id/photos/auto-colour", async (req, res) => {
  await query("UPDATE photos SET colour_by = '' WHERE car_id = $1 AND colour IS NULL AND colour_by = 'checked'", [req.params.id]);
  const n = await tagCarPhotos(req.params.id);
  await contentChanged();
  req.session.flash = { type: n ? "ok" : "info", text: n ? `${n} photos got a colour. Check them, and set the rest by hand.` : "No photo could be matched to a colour with certainty. White, black and silver cars cannot be told apart automatically; set those by hand." };
  res.redirect(`/admin/cars/${req.params.id}/photos`);
});

carsRouter.post("/:id/photos/:pid", async (req, res) => {
  if (req.body.action === "delete") await query("DELETE FROM photos WHERE id = $1 AND car_id = $2", [req.params.pid, req.params.id]);
  else await query("UPDATE photos SET kind = $3, sort = $4, colour = NULLIF($5, ''), colour_by = 'editor' WHERE id = $1 AND car_id = $2", [req.params.pid, req.params.id, req.body.kind || "front", Number(req.body.sort) || 0, String(req.body.colour ?? "").trim()]);
  await contentChanged();
  req.session.flash = { type: "ok", text: req.body.action === "delete" ? "Photo removed." : "Photo updated." };
  res.redirect(`/admin/cars/${req.params.id}/photos`);
});

// ---- Variants ----
carsRouter.get("/:id/variants", async (req, res, next) => {
  const car = await getCar(req.params.id);
  if (!car) return next();
  const list = await rows("SELECT * FROM variants WHERE car_id = $1 ORDER BY sort, price", [car.id]);
  const text = list.map((v) => [v.name, v.fuel, v.trans, v.price, (v.highlights ?? []).join("; ")].join(" | ")).join("\n");
  res.render("car-variants", { title: `Variants: ${car.brand_name} ${car.name}`, car, list, text });
});

carsRouter.post("/:id/variants", async (req, res) => {
  const lines = String(req.body.text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const parsed = [];
  for (const [i, l] of lines.entries()) {
    const [name, fuel, trans, price, hl] = l.split("|").map((s) => s.trim());
    if (!name || !FUELS.includes(fuel) || !["Manual", "Automatic"].includes(trans) || !(Number(price) > 0)) {
      req.session.flash = { type: "err", text: `Line ${i + 1} is not in the format: Name | Fuel | Manual or Automatic | price in lakh | highlight; highlight` };
      return res.redirect(`/admin/cars/${req.params.id}/variants`);
    }
    parsed.push({ name, fuel, trans, price: Number(price), highlights: toList((hl ?? "").replace(/;/g, ",")), slug: slugify(`${name} ${trans}`), sort: i });
  }
  await tx(async (c) => {
    await c.query("DELETE FROM variants WHERE car_id = $1", [req.params.id]);
    for (const v of parsed) await c.query("INSERT INTO variants (car_id, slug, name, fuel, trans, price, highlights, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (car_id, slug) DO NOTHING", [req.params.id, v.slug, v.name, v.fuel, v.trans, v.price, v.highlights, v.sort]);
    if (parsed.length) await c.query("UPDATE cars SET min_price = $2, max_price = $3, updated_at = now() WHERE id = $1", [req.params.id, Math.min(...parsed.map((v) => v.price)), Math.max(...parsed.map((v) => v.price))]);
  });
  await audit(req, "update-variants", "cars", req.params.id, `${parsed.length} variants`);
  await contentChanged();
  req.session.flash = { type: "ok", text: `Saved ${parsed.length} variants. Starting and top prices were updated from them.` };
  res.redirect(`/admin/cars/${req.params.id}/variants`);
});

// ---- AI and keywords ----
carsRouter.post("/:id/ai-copy", async (req, res) => {
  try {
    const r = await writeCarPageCopy(req, req.params.id);
    req.session.flash = { type: "ok", text: `AI (${r.provider}) wrote the summary line, pros, cons, overview and FAQs. Read them below and adjust anything that is not right, then Save.` };
  } catch (err) {
    req.session.flash = { type: "err", text: err.message };
  }
  res.redirect(`/admin/cars/${req.params.id}#content`);
});

carsRouter.post("/:id/ai-review", async (req, res) => {
  try {
    const id = await draftReview(req, req.params.id);
    req.session.flash = { type: "ok", text: "AI wrote an expert review draft. Check it, then Publish." };
    res.redirect(`/admin/articles/${id}`);
  } catch (err) {
    req.session.flash = { type: "err", text: err.message };
    res.redirect(`/admin/cars/${req.params.id}`);
  }
});

carsRouter.post("/:id/keywords", async (req, res) => {
  const car = await getCar(req.params.id);
  const cities = await rows("SELECT slug, name FROM cities ORDER BY sort");
  const pairs = await rows("SELECT a.slug AS a_slug, ab.slug AS a_brand, a.name AS a_name, bc.slug AS b_slug, bb.slug AS b_brand, bc.name AS b_name, a.id AS a_id FROM compare_pairs p JOIN cars a ON a.id = p.a_id JOIN brands ab ON ab.id = a.brand_id JOIN cars bc ON bc.id = p.b_id JOIN brands bb ON bb.id = bc.brand_id WHERE p.a_id = $1 OR p.b_id = $1", [car.id]);
  const rivals = pairs.map((p) => ({ name: p.a_id === car.id ? p.b_name : p.a_name, pairSlug: `${p.a_brand}-${p.a_slug}-vs-${p.b_brand}-${p.b_slug}` }));
  const list = carKeywords({ brand: car.brand_name, brandSlug: car.brand_slug, name: car.name, slug: car.slug, status: car.status, fuels: car.fuels, auto: car.auto }, { cities, rivals });
  let added = 0;
  for (const k of list) added += (await query("INSERT INTO keywords (phrase, intent, priority, target_path, source) VALUES ($1,$2,$3,$4,'pattern') ON CONFLICT (phrase) DO NOTHING", [k.phrase, k.intent, k.priority, k.target_path])).rowCount;
  req.session.flash = { type: "ok", text: `Added ${added} new keywords for this car (${list.length - added} were already in the bank).` };
  res.redirect(`/admin/cars/${car.id}#seo`);
});
