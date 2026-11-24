// CarScrapper tab: runs ../cardekho/scrape.py (Python) from the CMS, streams its log into import_runs,
// counts new / updated / unchanged cars, saves the result into the CMS database (cardekho_* tables),
// copies pictures into the Media library, and starts scheduled runs. Only one job runs at a time, in its own process.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { ROOT, config } from "../config.js";
import { getSetting, one, query, rows, setSetting } from "../db.js";
import { importCityPrices, importData, importExtras, importPhotos } from "./cardekho-import.js";
import { importDealers } from "./dealer-import.js";
import { syncCatalogue } from "./catalogue-sync.js";
import { importFuel } from "./fuel-import.js";
import { writeCarCopies } from "./car-copy.js";
import { importSpins } from "./spin-import.js";
import { matchBrand } from "./name-match.js";
import { slugify } from "./text.js";
import { describe, isDue, optionArgs } from "./carscraper-schedule.js";

export const SCRIPT = config.carScraper.script;
export const DATA_DIR = path.join(path.dirname(SCRIPT), "cardekho_data");
const LOG_DIR = path.join(DATA_DIR, "logs");

// A step is a scrape.py call ({ py: [...] }) or work done inside the CMS ({ db: [...] } saves files into the database).
const py = (...args) => ({ py: args });
const db = (...keys) => ({ db: keys });
const photos = (kind = null) => ({ photos: true, kind }); // kind: "launched" / "upcoming" / null for all saved cars
const site = (kind = null) => ({ site: true, kind }); // put the saved cars on the website (catalogue tables)
const ALL = ["upcoming", "cars", "upcoming_variants", "variants"];
// Our own copy for car pages (summary, verdict, pros, cons, guide, FAQs). newOnly: just cars that have none yet.
const copy = (newOnly = false) => ({ copy: true, newOnly });

// What the buttons do. Every job runs the whole chain by itself: scrape -> CMS database -> new photos into the
// Media library -> website. Pictures already copied and cars that did not change are skipped, so later runs are quick.
export const MODES = {
  cars: { label: "Launched cars", what: "Every car on sale (about 277 models): price, variants list, colours, specs, features, review. Saved in the CMS database, new photos copied, website updated, page copy written for new cars.", steps: [py(), db("cars"), photos("launched"), site("launched"), copy(true)], time: "about 15 min for all (the first time photos add about 40 min)" },
  latest: { label: "Latest launches", what: "Only the cars on the Latest cars page (about 30). Saved, photos copied, website updated.", steps: [py("--latest"), db("cars"), photos("launched"), site("launched"), copy(true)], time: "about 2 min" },
  upcoming: { label: "Upcoming cars", what: "Cars not launched yet (about 270): expected price, launch date, the specs known so far. Saved, photos copied, website updated.", steps: [py("--upcoming"), db("upcoming"), photos("upcoming"), site("upcoming"), copy(true)], time: "about 15 min for all (the first time photos add about 20 min)" },
  variants: { label: "Variants of launched cars", what: "Every variant page (about 1,900): full specs, features and on-road price per variant. Saved, website variants and specs updated.", steps: [py("--variants"), db("variants"), site("launched")], time: "about 60 min for all" },
  upcoming_variants: { label: "Variants of upcoming cars", what: "Variant pages of the saved upcoming cars (about 290). Saved, website updated.", steps: [py("--upcoming", "--variants"), db("upcoming_variants"), site("upcoming")], time: "about 8 min" },
  everything: { label: "Everything", what: "Launched cars, their variants, upcoming cars and their variants, one after another; then saved, photos copied and the website updated.", steps: [py(), py("--variants"), py("--upcoming"), py("--upcoming", "--variants"), db(...ALL), photos(), site(), copy(true)], time: "about 1.5 hours with Refresh" },
  save_db: { label: "Save to CMS database", what: "No scraping: saves the files already scraped into the CMS database and updates the website. Shows what is new and what changed.", steps: [db(...ALL), site()], time: "about a minute", noScrape: true },
  photos: { label: "Import photos", what: "Only photos: copies the pictures still missing (or that failed before) into the Media library and puts them on the website. The car scrapes already do this by themselves.", steps: [photos(), site()], time: "about 1 hour the first time; Brand / Max to do a part", noScrape: true },
  dealers: {
    label: "Car dealers (showrooms)",
    what: "Every brand's showrooms in each city of the website: name, address, phone and opening hours. Shown on each car's Dealers tab.",
    steps: [{ py: ["--dealers"], withCities: true }, { dealerDb: true }],
    simple: true,
    time: "about 10 min (one page per brand and city)",
  },
  city_prices: {
    label: "On-road prices by city",
    what: "CarDekho's on-road price of every variant of every launched car in each city of the website (RTO, insurance and charges for the base variant). The website shows these instead of its own estimate.",
    steps: [{ resolveCities: true }, { py: ["--city-prices"], withCities: true }, { cityDb: true }, site("launched")],
    cityAware: true,
    time: "about 1 hour for all cars in 8 cities (one page per car and city)",
  },
  fuel: {
    label: "Fuel prices",
    what: "Today's petrol, diesel and CNG prices: each city's own rate from CarDekho, else its state's rate, else the official PPAC rate.",
    steps: [{ resolveCities: true }, { py: ["--fuel"], withCities: true }, { fuel: true }],
    time: "under a minute (a few seconds more for each new city)",
    cityAware: true,
    noBrand: true,
  },
  gallery: {
    label: "Full photo gallery",
    what: "Reads every car's full gallery (often 100+ photos: exterior angles, details, dashboard, seats, boot) with its title, copies the new photos into the Media library in HD and puts them on the website: gallery tabs and the 360 view.",
    steps: [py("--reviews"), { extras: true }, photos(), site()],
    time: "about 2 s per car to read, then about 1 s per new photo (many hours the first time for every car; Brand / Max to do a part)",
  },
  threesixty: {
    label: "360 view (CarWale / CarDekho)",
    what: "Finds each car's studio 360 view: CarWale's first (72 frames, one every 5 degrees, with open doors and the cabin where offered; CarWale's watermark stays), else CarDekho's own spin (about 36 frames). Copies the frames into the uploads folder and puts the 360 view on the website. Views already copied are skipped.",
    steps: [py("--threesixty"), { spins: true }],
    time: "about 3 s per car to look up, then about 30 s per 360 view to copy (about 2 hours for every car the first time; Brand / Max to do a part)",
  },
  car_copy: {
    label: "Car pages: AI copy",
    what: "Reads CarDekho's expert review of every car (pros, cons, verdict) as research, then the AI writes each car page in our own words with its keywords: summary, verdict, pros, cons, buying guide and FAQs. Nothing is copied (checked against the review and against other cars). Unchanged cars are skipped; Refresh writes all again.",
    steps: [py("--reviews"), { extras: true }, copy()],
    time: "about 20 s per car (about 2 hours for every car the first time; Brand / Max to do a part)",
  },
  website: { label: "Update website", what: "No scraping: puts every saved car on the website again (prices, variants, specs, features, colours, photos). Unchanged cars are skipped.", steps: [site()], time: "about a minute", noScrape: true },
};

// Data files shown on the Data screen and offered for download.
export const FILES = [
  { file: "cars.jsonl", csv: "cars.csv", quality: "quality.txt", label: "Launched cars" },
  { file: "variants.jsonl", csv: "variants.csv", quality: "variants_quality.txt", label: "Variants of launched cars" },
  { file: "upcoming.jsonl", csv: "upcoming.csv", quality: "upcoming_quality.txt", label: "Upcoming cars" },
  { file: "upcoming_variants.jsonl", csv: "upcoming_variants.csv", quality: "upcoming_variants_quality.txt", label: "Variants of upcoming cars" },
];
export const DOWNLOADS = new Set(FILES.flatMap((f) => [f.file, f.csv, f.quality]));

const KEEP_LINES = 400; // lines kept in the database while a run is going (the full log is in a file)
const KEEP_CHANGES = 300;

// Every job runs in its own worker process (src/scripts/carscraper-worker.js), started detached, so it keeps going
// when the CMS restarts (node --watch after a code change, a crash, a deploy). The CMS only reads the job's row in
// import_runs and asks it to stop through the "carscraper_stop" setting.
const WORKER = path.join(ROOT, "src", "scripts", "carscraper-worker.js");
// A job with no worker process id after this long was saved but its worker never started (the CMS stopped or restarted
// in that moment); it is started then, rather than failed.
const STARTUP_GRACE_MS = 15 * 1000;

const stamp = () => new Date().toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" });

/** True while a process with this id exists. */
export function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

const markGone = (id, why) => query("UPDATE import_runs SET status = 'failed', finished_at = now(), log = log || $2 WHERE id = $1 AND status = 'running'", [id, `\n${stamp()}  ${why} Run it again to continue from where it stopped.`]);

/** Starts the worker process for a saved job and records its process id. */
async function launchWorker(id) {
  const child = spawn(process.execPath, [WORKER, String(id)], { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true, env: process.env });
  child.on("error", (err) => void markGone(id, `Could not start the worker: ${err.message}.`));
  if (child.pid) await query("UPDATE import_runs SET summary = jsonb_set(summary, '{pid}', to_jsonb($2::int)) WHERE id = $1", [id, child.pid]);
  child.unref();
  return child.pid ?? null;
}

/**
 * The running job ({ id, mode }) or null. A job whose worker died is closed as failed; a job whose worker never
 * started (no process id) is started now.
 */
export async function runningNow() {
  const r = await one("SELECT id, kind, summary, started_at FROM import_runs WHERE kind LIKE 'carscraper:%' AND status = 'running' ORDER BY id DESC LIMIT 1");
  if (!r) return null;
  const pid = r.summary?.pid;
  if (pid && !alive(pid)) {
    await markGone(r.id, "The worker process stopped unexpectedly.");
    return runningNow();
  }
  if (!pid && Date.now() - new Date(r.started_at).getTime() > STARTUP_GRACE_MS) {
    await query("UPDATE import_runs SET log = log || $2 WHERE id = $1", [r.id, `${stamp()}  The worker had not started (the CMS restarted at that moment); starting it now.\n`]);
    if (!(await launchWorker(r.id))) await markGone(r.id, "The worker process could not be started.");
    return runningNow();
  }
  return { id: r.id, mode: r.kind.split(":")[1] };
}

/** Steps of a mode. */
export const stepsFor = (mode) => MODES[mode].steps;

/** The brand slug for whatever was typed ("TATA", "Maruti Suzuki", "merc", "huyndai"); a clear error when none fits. */
export async function brandSlug(text) {
  const brands = await rows("SELECT DISTINCT split_part(slug, '/', 1) AS slug, brand AS name FROM cardekho_cars").catch(() => []);
  if (!brands.length) return slugify(text);
  const { brand, suggestions } = matchBrand(text, brands);
  if (!brand) throw new Error(`Brand "${text}" was not found${suggestions.length ? `. Did you mean ${suggestions.join(", ")}?` : "."}`);
  return brand.slug;
}

/** Starts a job in its own background process and returns its run id. Throws when one is already running. */
export async function startScrape(mode, options = {}, by = "manual") {
  const m = MODES[mode];
  if (!m) throw new Error("Unknown scrape type.");
  if (m.simple) options = {}; // nothing to choose for this job
  if (m.noBrand) options = { ...options, brand: null };
  if (!m.cityAware) options = { ...options, city: null };
  if (options.brand) options = { ...options, brand: await brandSlug(options.brand) };
  const live = await runningNow();
  if (live) throw new Error(`A job is already running (run #${live.id}). Wait for it or press Stop.`);
  const steps = stepsFor(mode);
  if (steps.some((s) => s.py) && !existsSync(SCRIPT)) throw new Error(`scrape.py not found at ${SCRIPT}. Set CARSCRAPER_SCRIPT in .env.`);
  const summary = { mode, label: m.label, options, by, step: 0, steps: steps.length, done: 0, total: 0, counts: { NEW: 0, UPDATED: 0, SAME: 0, skipped: 0 }, changes: [], pid: null };
  const { id } = await one("INSERT INTO import_runs (kind, summary) VALUES ($1, $2) RETURNING id", [`carscraper:${mode}`, JSON.stringify(summary)]);
  await launchWorker(id);
  return id;
}

/** Asks the running job to stop. What was saved so far stays; a later run continues from there. */
export async function stopScrape() {
  const live = await runningNow();
  if (!live) return false;
  await setSetting("carscraper_stop", live.id);
  return true;
}

/** Runs one job; called by the worker process. */
export async function runWorker(id) {
  const row = await one("SELECT * FROM import_runs WHERE id = $1", [id]);
  if (!row || row.status !== "running") throw new Error(`Run #${id} is not waiting to run.`);
  const summary = { ...row.summary, pid: process.pid };
  const m = MODES[summary.mode];
  await runSteps({ id, child: null, stopping: false }, m, stepsFor(summary.mode), summary.options ?? {}, summary);
}

const keepChange = (s, line) => {
  s.changes.push(line);
  if (s.changes.length > KEEP_CHANGES) s.changes.shift();
};

/** One line of scrape.py output -> progress and counters. */
export function readLine(line, s) {
  const p = /^\[(\d+)\/(\d+)\]/.exec(line);
  if (p) {
    s.done = Number(p[1]);
    s.total = Number(p[2]);
  }
  const k = / \| (NEW|UPDATED|SAME)\b/.exec(line);
  if (k) {
    s.counts[k[1]] += 1;
    if (k[1] !== "SAME") keepChange(s, line);
  } else if (p && /: skipped/.test(line)) s.counts.skipped += 1;
  const f = /^(\d+) models found, (\d+) already saved, (\d+) to fetch/.exec(line) || /^\d+ cars, (\d+) variants, (\d+) already saved, (\d+) to fetch/.exec(line);
  if (f) {
    s.done = 0;
    s.total = Number(f[3]);
  }
}

const stepText = (s, options) => {
  if (s.py) return `python scrape.py ${[...s.py, ...optionArgs(options, s.py.includes("--variants"))].join(" ")}`;
  if (s.db) return `save into the CMS database: ${s.db.join(", ")}`;
  if (s.resolveCities) return options.city ? `find the cities "${options.city}" on CarDekho and add new ones to the website` : "use every city of the website";
  if (s.cityDb) return "save the on-road prices by city into the CMS database";
  if (s.spins) return `copy the 360 view frames into the uploads folder${options.brand ? ` (brand ${options.brand})` : ""}${options.limit ? ` (max ${options.limit} views)` : ""}`;
  if (s.dealerDb) return "save the showrooms into the CMS database (Dealers)";
  if (s.extras) return "add the gallery and expert review read from the model pages to the saved cars";
  if (s.copy) return s.newOnly ? "write the page copy (AI) of cars that have none yet" : `write the page copy (AI): summary, verdict, pros, cons, guide, FAQs${options.brand ? ` (brand ${options.brand})` : ""}${options.limit ? ` (max ${options.limit} cars)` : ""}`;
  if (s.fuel) return "put today's fuel prices on the website (city rate, else state rate, else PPAC)";
  if (s.site) return `update the website with the saved ${s.kind ? `${s.kind} ` : ""}cars${options.brand ? ` (brand ${options.brand})` : ""}`;
  return `copy new pictures of the ${s.kind ? `${s.kind} ` : ""}cars into the Media library${options.brand ? ` (brand ${options.brand})` : ""}${options.limit && !s.kind ? ` (max ${options.limit} cars)` : ""}`;
};

async function runSteps(run, m, steps, options, summary) {
  mkdirSync(LOG_DIR, { recursive: true });
  const file = createWriteStream(path.join(LOG_DIR, `run-${run.id}.log`), { flags: "a" });
  const tail = [];
  let dirty = true;
  const add = (text) => {
    const line = `${stamp()}  ${text}`;
    tail.push(line);
    if (tail.length > KEEP_LINES) tail.shift();
    file.write(`${line}\n`);
    dirty = true;
  };
  const flush = async (extra = "") => {
    if (!dirty && !extra) return;
    dirty = false;
    await query(`UPDATE import_runs SET log = $2, summary = $3 ${extra} WHERE id = $1`, [run.id, tail.join("\n"), JSON.stringify(summary)]);
  };
  const ctx = {
    summary,
    log: add,
    change: (line) => {
      keepChange(summary, line);
      add(line);
    },
    progress: (done, total) => {
      summary.done = done;
      summary.total = total;
      dirty = true;
    },
    stopped: () => run.stopping,
  };
  // Every 2 s: save the log and look for a Stop request from the CMS.
  const timer = setInterval(() => {
    void flush().catch(() => {});
    void getSetting("carscraper_stop", null).then((stop) => {
      if (Number(stop) === run.id && !run.stopping) {
        run.stopping = true;
        run.child?.kill();
      }
    }).catch(() => {});
  }, 2000);
  let status = "done";
  try {
    add(`Started by ${summary.by}: ${m.label}${m.noScrape || m.simple ? "" : options.refresh ? " (refresh: fetch again what is saved)" : " (only what is not saved yet)"}${options.brand ? `, brand ${options.brand}` : ""}${options.limit ? `, max ${options.limit}` : ""}`);
    for (const [i, step] of steps.entries()) {
      if (run.stopping) break;
      summary.step = i + 1;
      summary.done = 0;
      summary.total = 0;
      add(`Step ${i + 1}/${steps.length}: ${stepText(step, options)}`);
      if (step.py) {
        // The cities come from the CMS (Places & prices > Cities), as "slug=Name" pairs.
        // The cities: the ones typed into the City box (found and added in the first step), else every city of the website.
        const list = await rows("SELECT slug, name FROM cities WHERE ($1::text[] IS NULL OR slug = ANY($1)) ORDER BY sort, name", [ctx.cityFilter ?? null]);
        const cityArgs = step.withCities ? ["--cities", list.map((c) => `${c.slug}=${c.name}`).join(",")] : [];
        const code = await runChild(run, [...step.py, ...cityArgs, ...optionArgs(options, step.py.includes("--variants"))], (line) => {
          readLine(line, summary);
          add(line);
        });
        if (run.stopping) break;
        if (code !== 0) {
          add(`scrape.py stopped with exit code ${code}. What was saved so far is kept; run again to continue.`);
          status = "failed";
          break;
        }
      } else if (step.db) await importData(ctx, DATA_DIR, step.db);
      else if (step.site) await syncCatalogue(ctx, { brand: options.brand, kind: step.kind });
      else if (step.resolveCities) await resolveCities(run, ctx, options);
      else if (step.fuel) await importFuel(ctx, DATA_DIR, ctx.cityFilter);
      else if (step.cityDb) await importCityPrices(ctx, DATA_DIR);
      else if (step.extras) await importExtras(ctx, DATA_DIR);
      else if (step.dealerDb) await importDealers(ctx, DATA_DIR);
      else if (step.spins) await importSpins(ctx, DATA_DIR, { brand: options.brand, limit: options.limit });
      else if (step.copy) await writeCarCopies(ctx, DATA_DIR, step.newOnly ? { brand: options.brand, onlyNew: true } : { brand: options.brand, limit: options.limit, refresh: options.refresh });
      else {
        // After a scrape, Max limits the scrape only; photos are caught up for every saved car of that kind.
        // Each car goes on the website as soon as its photos are in.
        ctx.onCarPhotos = (slug) => syncCatalogue(ctx, { slugs: [slug], quiet: true });
        await importPhotos(ctx, { brand: options.brand, limit: step.kind ? null : options.limit, kind: step.kind });
        ctx.onCarPhotos = null;
      }
    }
    if (run.stopping) {
      status = "stopped";
      add("Stopped by hand. Saved data is kept; the next run continues from here.");
    }
    const c = summary.counts;
    const parts = [];
    if (steps.some((s) => s.py) && !m.simple) parts.push(`scrape ${c.NEW} new, ${c.UPDATED} updated, ${c.SAME} unchanged, ${c.skipped} skipped`);
    if (summary.db) parts.push(`CMS database ${summary.db.NEW} new, ${summary.db.UPDATED} updated, ${summary.db.SAME} unchanged`);
    if (summary.photos) parts.push(`photos ${summary.photos.done} new, ${summary.photos.upgraded ?? 0} replaced by HD, ${summary.photos.failed} failed`);
    if (summary.fuel) parts.push(`fuel prices ${summary.fuel.cardekho} city, ${summary.fuel.state} state, ${summary.fuel.ppac} PPAC, ${summary.fuel.missing} missing`);
    if (summary.site) parts.push(`website ${summary.site.NEW} added, ${summary.site.UPDATED} updated, ${summary.site.SAME} unchanged`);
    add(`Result: ${parts.join(" · ") || "nothing to do"}.`);
  } catch (err) {
    status = "failed";
    add(`Failed: ${err.message}`);
  } finally {
    clearInterval(timer);
    file.end();
    dirty = true;
    await flush(`, status = '${status}', finished_at = now()`).catch((err) => console.error("CarScrapper:", err.message));
    if (Number(await getSetting("carscraper_stop", null).catch(() => null)) === run.id) await setSetting("carscraper_stop", null).catch(() => {});
  }
}

/**
 * City box: finds each typed city on CarDekho (any spelling: "chandigarh", "BENGALURU", "gurugram", small typos),
 * adds the ones the website does not have yet (name, slug and state from CarDekho), and limits the job to them.
 */
async function resolveCities(run, ctx, options) {
  if (!options.city) return;
  const found = [];
  const code = await runChild(run, ["--resolve-cities", options.city], (line) => {
    if (line.startsWith("CITY ")) {
      try {
        found.push(JSON.parse(line.slice(5)));
      } catch {
        // not a result line
      }
    } else ctx.log(line);
  });
  if (code !== 0) throw new Error("Could not read CarDekho's city list.");
  const slugs = [];
  for (const c of found) {
    if (c.error) {
      ctx.log(`City "${c.input}": not found on CarDekho${c.suggestions?.length ? `. Did you mean ${c.suggestions.join(", ")}?` : "."}`);
      continue;
    }
    const slug = c.slug || slugify(c.name);
    const have = await one("SELECT slug, name FROM cities WHERE slug = $1 OR lower(name) = lower($2) LIMIT 1", [slug, c.name]);
    if (have) {
      slugs.push(have.slug);
      ctx.log(`City "${c.input}" = ${have.name} (already on the website).`);
    } else {
      await query("INSERT INTO cities (slug, name, state, rto, ins, sort) VALUES ($1, $2, $3, 0.1, 0.05, 100)", [slug, c.name, c.state || c.name]);
      slugs.push(slug);
      ctx.change(`CITY     ${c.name} | added to the website (${c.state || "state not known"})`);
    }
  }
  if (!slugs.length) throw new Error(`None of the cities "${options.city}" were found on CarDekho.`);
  ctx.cityFilter = slugs;
}

function runChild(run, args, onLine) {
  return new Promise((resolve) => {
    const child = spawn(config.carScraper.python, ["-u", SCRIPT, ...args], {
      cwd: path.dirname(SCRIPT),
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      windowsHide: true,
    });
    run.child = child;
    readline.createInterface({ input: child.stdout }).on("line", onLine);
    readline.createInterface({ input: child.stderr }).on("line", (l) => onLine(`! ${l}`));
    child.on("error", (err) => {
      onLine(`Could not start Python (${config.carScraper.python}): ${err.message}. Set CARSCRAPER_PYTHON in .env.`);
      resolve(-1);
    });
    child.on("close", (code) => {
      run.child = null;
      resolve(code ?? -1);
    });
  });
}

// ---- data files -------------------------------------------------------------------------------

const lineCache = new Map();

function countLines(p, mtime) {
  const hit = lineCache.get(p);
  if (hit && hit.mtime === mtime) return hit.n;
  const buf = readFileSync(p);
  let n = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n += 1;
  lineCache.set(p, { mtime, n });
  return n;
}

/** Counts, size and age of each data file, plus its missing-field report. */
export function dataFiles() {
  return FILES.map((f) => {
    const p = path.join(DATA_DIR, f.file);
    if (!existsSync(p)) return { ...f, missing: true, count: 0, quality: [] };
    const st = statSync(p);
    const qp = path.join(DATA_DIR, f.quality);
    return { ...f, count: countLines(p, st.mtimeMs), size: st.size, mtime: st.mtime, quality: existsSync(qp) ? parseQuality(readFileSync(qp, "utf8")) : [], csvExists: existsSync(path.join(DATA_DIR, f.csv)) };
  });
}

/** "price_range: 0 / 277   e.g. a, b" lines -> rows. */
export function parseQuality(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z_]+): (\d+) \/ (\d+)(?:\s+e\.g\. (.*))?$/.exec(line.trim());
    if (m) out.push({ field: m[1], missing: Number(m[2]), of: Number(m[3]), examples: m[4] ? m[4].split(", ") : [] });
  }
  return out;
}

export const runLogFile = (id) => path.join(LOG_DIR, `run-${Number(id)}.log`);

// ---- schedule ---------------------------------------------------------------------------------

export const getSchedules = () => getSetting("carscraper_schedules", []);
export const saveSchedules = (list) => setSetting("carscraper_schedules", list);
export const getScheduleState = () => getSetting("carscraper_schedule_state", {});

export async function markScheduleRun(id, when = Date.now()) {
  const state = await getScheduleState();
  state[id] = when;
  await setSetting("carscraper_schedule_state", state);
}

/** Starts a saved schedule now (button or timer). */
export async function runSchedule(job, by) {
  await markScheduleRun(job.id);
  return startScrape(job.mode, job.options ?? {}, by ?? `schedule "${MODES[job.mode]?.label}" (${describe(job)})`);
}

async function scheduleTick() {
  if (await runningNow()) return; // a missed start runs once the current job is done
  const jobs = await getSchedules();
  const state = await getScheduleState();
  const now = Date.now();
  const job = jobs.find((j) => MODES[j.mode] && isDue(j, state[j.id], now));
  if (job) await runSchedule(job);
}

/** Called once when the CMS starts. Jobs keep running in their own process; only a job whose worker is gone is closed. */
export async function startCarScraper({ schedule = true } = {}) {
  await runningNow();
  if (!schedule) return;
  const tick = () => scheduleTick().catch((err) => console.error("CarScrapper schedule:", err.message));
  setTimeout(tick, 30 * 1000);
  setInterval(tick, 60 * 1000);
}
