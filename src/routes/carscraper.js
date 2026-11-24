// CarScrapper tab: buttons to run ../cardekho/scrape.py, live logs, schedules, and the collected data files.
// Separate from the "Scraper" section (that one talks to ../automotive-scraper).
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { one, rows } from "../db.js";
import { requireAdmin } from "../lib/auth.js";
import { DATA_DIR, DOWNLOADS, MODES, SCRIPT, dataFiles, getScheduleState, getSchedules, runLogFile, runSchedule, runningNow, saveSchedules, startScrape, stopScrape } from "../lib/carscraper.js";
import { FREQS, WEEKDAYS, describe, nextRun, parseJob, parseOptions } from "../lib/carscraper-schedule.js";
import { audit } from "../lib/publish.js";

export const carScraperRouter = Router();

const flash = (req, type, text) => {
  req.session.flash = { type, text };
};
const recentRuns = (limit = 15) => rows("SELECT id, kind, status, summary, started_at, finished_at FROM import_runs WHERE kind LIKE 'carscraper:%' ORDER BY id DESC LIMIT $1", [limit]);

/** Rows saved in the CMS database (null when the tables are not created yet: run npm run migrate). */
async function dbCounts() {
  try {
    return await one(`SELECT
      (SELECT count(*)::int FROM cardekho_cars WHERE kind = 'launched') AS launched,
      (SELECT count(*)::int FROM cardekho_cars WHERE kind = 'upcoming') AS upcoming,
      (SELECT count(*)::int FROM cardekho_variants) AS variants,
      (SELECT count(*)::int FROM cardekho_photos WHERE status = 'done') AS photos,
      (SELECT count(*)::int FROM cardekho_photos WHERE status = 'failed') AS photos_failed,
      (SELECT max(updated_at) FROM cardekho_cars) AS last_saved`);
  } catch {
    return null;
  }
}

carScraperRouter.get("/", async (req, res) => {
  const live = await runningNow();
  res.render("carscraper", {
    title: "CarScrapper",
    MODES,
    live,
    liveRun: live ? await one("SELECT * FROM import_runs WHERE id = $1", [live.id]) : null,
    runs: await recentRuns(),
    files: dataFiles(),
    db: await dbCounts(),
    ...(await pickLists()),
    scriptFound: existsSync(SCRIPT),
    script: SCRIPT,
  });
});

/** Suggestions for the Brand and City boxes: saved brands, the website's cities and CarDekho's city list. */
async function pickLists() {
  const brandNames = (await rows("SELECT DISTINCT brand FROM cardekho_cars WHERE brand <> '' ORDER BY brand").catch(() => [])).map((r) => r.brand);
  const site = (await rows("SELECT name FROM cities ORDER BY sort, name").catch(() => [])).map((r) => r.name);
  let catalog = [];
  try {
    const file = path.join(DATA_DIR, "city_catalog.json");
    if (existsSync(file)) catalog = JSON.parse(readFileSync(file, "utf8")).map((c) => c.name).filter(Boolean);
  } catch {
    catalog = [];
  }
  return { brandNames, cityNames: [...new Set([...site, ...catalog.sort()])] };
}

// ---- cars saved in the CMS database ------------------------------------------------------------

const PAGE = 50;

carScraperRouter.get("/cars", async (req, res) => {
  const counts = await dbCounts();
  if (!counts) return res.render("error", { title: "Tables missing", message: "Run npm run migrate in cms_cardekho, then restart the CMS." });
  const q = String(req.query.q ?? "").trim().slice(0, 80);
  const kind = ["launched", "upcoming"].includes(req.query.kind) ? req.query.kind : "";
  const brand = String(req.query.brand ?? "").slice(0, 60);
  const page = Math.max(1, Number(req.query.page) || 1);
  const where = ["($1 = '' OR c.name ILIKE '%' || $1 || '%' OR c.slug ILIKE '%' || $1 || '%')", "($2 = '' OR c.kind = $2)", "($3 = '' OR c.brand = $3)"];
  const params = [q, kind, brand];
  const total = (await one(`SELECT count(*)::int AS n FROM cardekho_cars c WHERE ${where.join(" AND ")}`, params)).n;
  const list = await rows(`SELECT c.id, c.slug, c.kind, c.brand, c.name, c.price_range, c.ex_showroom_min, c.fuel, c.body_type, c.transmission, c.variants_count, c.expected_launch, c.updated_at,
      (SELECT m.url FROM cardekho_photos p JOIN media m ON m.id = p.media_id WHERE p.car_slug = c.slug AND p.status = 'done' ORDER BY p.kind DESC, p.sort LIMIT 1) AS photo,
      (SELECT count(*)::int FROM cardekho_photos p WHERE p.car_slug = c.slug AND p.status = 'done') AS photos
    FROM cardekho_cars c WHERE ${where.join(" AND ")} ORDER BY c.kind, c.brand, c.name LIMIT ${PAGE} OFFSET $4`, [...params, (page - 1) * PAGE]);
  const brands = await rows("SELECT brand, count(*)::int AS n FROM cardekho_cars GROUP BY brand ORDER BY brand");
  res.render("carscraper-cars", { title: "Saved cars", list, total, page, pages: Math.max(1, Math.ceil(total / PAGE)), q, kind, brand, brands, counts });
});

carScraperRouter.get("/cars/:id", async (req, res, next) => {
  const car = await one("SELECT * FROM cardekho_cars WHERE id = $1", [Number(req.params.id) || 0]).catch(() => null);
  if (!car) return next();
  const variants = await rows("SELECT id, variant, tag, status, fuel, transmission, price_text, ex_showroom, on_road, engine_cc, max_power, max_torque, mileage, range_km, battery, data FROM cardekho_variants WHERE car_slug = $1 ORDER BY ex_showroom NULLS LAST, variant", [car.slug]);
  const photos = await rows("SELECT p.kind, p.title, p.status, p.error, p.source_url, m.id AS media_id, m.url, m.w, m.h, m.bytes FROM cardekho_photos p LEFT JOIN media m ON m.id = p.media_id WHERE p.car_slug = $1 ORDER BY p.kind DESC, p.sort", [car.slug]);
  const open = Number(req.query.variant) || null;
  res.render("carscraper-car", { title: car.name, car, d: car.data || {}, variants, photos, open });
});

carScraperRouter.post("/run", requireAdmin, async (req, res) => {
  try {
    const mode = String(req.body.mode ?? "");
    const id = await startScrape(mode, parseOptions(req.body), `${req.session.user.name} (button)`);
    await audit(req, "carscraper-run", mode, id);
    res.redirect(`/admin/carscraper/runs/${id}`);
  } catch (err) {
    flash(req, "err", err.message);
    res.redirect("/admin/carscraper");
  }
});

carScraperRouter.post("/stop", requireAdmin, async (req, res) => {
  const live = await runningNow();
  if (await stopScrape()) {
    await audit(req, "carscraper-stop", live?.mode ?? "", live?.id ?? null);
    flash(req, "ok", "Stopping (takes a few seconds). Data saved so far is kept; the next run continues from there.");
  } else flash(req, "err", "Nothing is running.");
  res.redirect(live ? `/admin/carscraper/runs/${live.id}` : "/admin/carscraper");
});

carScraperRouter.get("/runs/:id", async (req, res, next) => {
  const run = await one("SELECT * FROM import_runs WHERE id = $1 AND kind LIKE 'carscraper:%'", [Number(req.params.id) || 0]);
  if (!run) return next();
  if (req.query.format === "json") return res.json({ id: run.id, status: run.status, log: run.log, summary: run.summary, finished_at: run.finished_at });
  res.render("carscraper-run", { title: `CarScrapper run #${run.id}`, run, mode: MODES[run.kind.split(":")[1]], hasFile: existsSync(runLogFile(run.id)) });
});

carScraperRouter.get("/runs/:id/log.txt", (req, res, next) => {
  const file = runLogFile(req.params.id);
  if (!existsSync(file)) return next();
  res.download(file, `carscrapper-run-${Number(req.params.id)}.log`);
});

// ---- schedule ---------------------------------------------------------------------------------

carScraperRouter.get("/schedule", async (req, res) => {
  const jobs = await getSchedules();
  const state = await getScheduleState();
  const now = Date.now();
  res.render("carscraper-schedule", {
    title: "CarScrapper schedule",
    MODES,
    FREQS,
    WEEKDAYS,
    jobs: jobs.map((j) => ({ ...j, text: describe(j), last: state[j.id] ? new Date(state[j.id]) : null, next: nextRun(j, state[j.id], now) })),
    live: await runningNow(),
    ...(await pickLists()),
  });
});

carScraperRouter.post("/schedule", requireAdmin, async (req, res) => {
  try {
    const job = { id: randomUUID(), ...parseJob(req.body, MODES), createdAt: Date.now() };
    await saveSchedules([...(await getSchedules()), job]);
    await audit(req, "carscraper-schedule-add", job.mode, job.id, describe(job));
    flash(req, "ok", `Schedule added: ${MODES[job.mode].label}, ${describe(job)}.`);
  } catch (err) {
    flash(req, "err", `Not saved: ${err.message}`);
  }
  res.redirect("/admin/carscraper/schedule");
});

const withJob = (fn) => async (req, res) => {
  const jobs = await getSchedules();
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) flash(req, "err", "That schedule no longer exists.");
  else await fn(req, res, job, jobs);
  if (!res.headersSent) res.redirect("/admin/carscraper/schedule");
};

carScraperRouter.post("/schedule/:id/toggle", requireAdmin, withJob(async (req, res, job, jobs) => {
  job.enabled = !job.enabled;
  await saveSchedules(jobs);
  await audit(req, job.enabled ? "carscraper-schedule-on" : "carscraper-schedule-off", job.mode, job.id);
  flash(req, "ok", job.enabled ? "Schedule switched on." : "Schedule paused.");
}));

carScraperRouter.post("/schedule/:id/delete", requireAdmin, withJob(async (req, res, job, jobs) => {
  await saveSchedules(jobs.filter((j) => j.id !== job.id));
  await audit(req, "carscraper-schedule-delete", job.mode, job.id);
  flash(req, "ok", "Schedule removed.");
}));

carScraperRouter.post("/schedule/:id/run", requireAdmin, withJob(async (req, res, job) => {
  try {
    const id = await runSchedule(job, `${req.session.user.name} (Run now on a schedule)`);
    await audit(req, "carscraper-run", job.mode, id, "from schedule");
    res.redirect(`/admin/carscraper/runs/${id}`);
  } catch (err) {
    flash(req, "err", err.message);
  }
}));

// ---- data -------------------------------------------------------------------------------------

carScraperRouter.get("/data", async (req, res) => {
  res.render("carscraper-data", { title: "CarScrapper data", files: dataFiles(), dataDir: DATA_DIR });
});

carScraperRouter.get("/data/:file", (req, res, next) => {
  const name = path.basename(req.params.file);
  if (!DOWNLOADS.has(name)) return next();
  const file = path.join(DATA_DIR, name);
  if (!existsSync(file)) return next();
  res.download(file, name);
});
