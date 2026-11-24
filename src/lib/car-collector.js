// The run behind the car "Run collector" button and the daily schedule. One pass does what used to
// be six manual screens:
//   1. Fetching  asks every switched-on data source (VariantWise, Wikipedia, ...) for new data
//   2. Cleaned   approves what the scraper collected (only sources with a permission on file)
//   3. Saved     imports it: new cars are created, existing cars get the new prices/variants/specs
//   4. Writing   finds free-licence photos on Wikimedia Commons for cars that have none
//   5. Writing   writes the buying-guide copy (AI) for cars that have a photo, price and variants
//   6. Saved     puts a car on the website once every page of it can be drawn (photo, price, variants,
//                a colour, and the guide's angle, pros and cons)
// Name, URL, copy, ratings and SEO of an existing car are never overwritten by an import.
// Line prefixes match the news scraper so the same window can show both.
import { rows } from "../db.js";
import { aiStatus } from "./ai.js";
import { writeCarPageCopy } from "./drafts.js";
import { tagCarPhotos, topUpPhotos } from "./car-photos.js";
import { contentChanged } from "./publish.js";
import { scraper } from "./scraper-client.js";
import { importRecord } from "./scraper-import.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Zero is a real answer here ("no AI guides"), so only a missing or non-numeric value falls back to the default.
const num = (n, lo, hi, d) => {
  const v = Number.parseInt(n, 10);
  return Number.isNaN(v) ? d : Math.min(hi, Math.max(lo, v));
};

/** Sources the collector may run: data sources only (news feeds have their own screen). */
const DATA_ADAPTERS = new Set(["licensed-provider", "wikipedia", "commons", "manufacturer"]);


/**
 * @param {{collect?: boolean, photoCars?: number, photosPerCar?: number, aiOverviews?: number, confirmUpdates?: boolean, log?: (l: string) => void, stopped?: () => boolean}} o
 */
export async function runCarCollector({ collect = true, photoCars = 15, photosPerCar = 12, aiOverviews = 3, confirmUpdates = true, log = () => {}, stopped = () => false } = {}) {
  const out = { fetched: 0, approved: 0, created: 0, updated: 0, unchanged: 0, imagesAdded: 0, brands: 0, otherImported: 0, failed: 0, photoCars: 0, photos: 0, shown: 0, copies: 0 };
  photoCars = num(photoCars, 0, 60, 15);
  photosPerCar = num(photosPerCar, 1, 40, 12);
  aiOverviews = num(aiOverviews, 0, 25, 3);
  const touched = new Set(); // cars created or changed in this run
  const halted = () => {
    if (!stopped()) return false;
    log("Stopped by user");
    return true;
  };

  // 1. Ask each data source for what is new.
  if (collect) {
    let sources;
    try {
      sources = (await scraper("/sources")).filter((s) => s.enabled && DATA_ADAPTERS.has(s.adapter));
    } catch (err) {
      log(`ERROR  The scraper service is not reachable: ${err.message}`);
      return out;
    }
    log(`Fetching  ${sources.length} data sources`);
    for (const s of sources) {
      if (halted()) return out;
      try {
        const job = await scraper("/jobs", { method: "POST", body: { sourceId: s.id, type: "incremental" } });
        let state = job;
        for (let i = 0; i < 160 && ["queued", "running"].includes(state.status); i++) {
          await sleep(3000);
          if (stopped()) break;
          state = await scraper(`/jobs/${job.id}`);
        }
        const st = state.stats ?? {};
        if (state.status === "succeeded") log(`Fetching  ${s.name} - ${st.found ?? 0} found, ${st.new ?? 0} new, ${st.updated ?? 0} updated`);
        else log(`ERROR  ${s.name}: ${state.status}${state.error ? ` (${String(state.error).slice(0, 120)})` : ""}`);
        out.fetched += Number(st.new ?? 0) + Number(st.updated ?? 0);
      } catch (err) {
        log(`ERROR  ${s.name}: ${err.message}`);
      }
    }
  }

  // 2. Approve what was collected. Imports into the catalogue are the scraper's own checked step.
  try {
    for (const type of ["brand", "model", "image"]) {
      for (let guard = 0; guard < 20; guard++) {
        if (halted()) return out;
        const page = await scraper(`/records?${new URLSearchParams({ status: "pending", entityType: type, limit: "100" })}`);
        const ids = page.items.map((r) => r.id);
        if (!ids.length) break;
        const r = await scraper("/records/approve", { method: "POST", body: { ids, reviewer: "collector" }, timeout: 600000 });
        out.approved += r.approved;
        if (r.failed.length) log(`Cleaned  ${r.failed.length} ${type} records could not be approved (${String(r.failed[0].error).slice(0, 100)})`);
        if (r.approved === 0) break; // nothing moved: do not loop on the same failures
      }
    }
    log(`Cleaned  ${out.approved} records approved`);
  } catch (err) {
    log(`ERROR  Approving failed: ${err.message}`);
  }

  // 3. Import every approved record into the CMS.
  const tried = new Set();
  try {
    for (let guard = 0; guard < 30; guard++) {
      const list = (await scraper("/approved?limit=200")).filter((r) => !tried.has(r.id));
      if (!list.length) break;
      for (const rec of list) {
        if (halted()) return out;
        tried.add(rec.id);
        try {
          const r = await importRecord(null, rec.id, { confirm: confirmUpdates });
          if (r.status === "awaiting_confirmation") continue; // left for an editor when auto-confirm is off
          // Only cars are counted as cars; photos, brands and news leads arrive through the same hand-off.
          const entity = r.result?.cmsEntity ?? (rec.entityType === "model" ? "cars" : rec.entityType);
          if (entity === "cars") {
            if (r.action === "create") {
              out.created++;
              log(`Saved  new car ${rec.title}`);
            } else if (r.action === "update") out.updated++;
            else out.unchanged++;
            if (r.action !== "skip" && r.result?.cmsId) touched.add(r.result.cmsId);
          } else if (entity === "photos") out.imagesAdded++;
          else if (entity === "brands" || rec.entityType === "brand") out.brands++;
          else out.otherImported++;
        } catch (err) {
          out.failed++;
          log(`ERROR  ${rec.title}: ${String(err.message).slice(0, 120)}`);
        }
      }
    }
    log(`Saved  ${out.created} new cars, ${out.updated} cars updated, ${out.unchanged} already up to date, ${out.imagesAdded} collected photos, ${out.brands} brands, ${out.otherImported} other${out.failed ? `, ${out.failed} failed` : ""}`);
  } catch (err) {
    log(`ERROR  Importing failed: ${err.message}`);
  }

  // 4. Real photos, as many as exist (up to photosPerCar), each tagged with the colour it shows.
  // Cars with the fewest photos come first; a car searched in the last two weeks is left alone.
  if (photoCars > 0) {
    const need = await rows(
      `SELECT c.id, c.name, c.colors, b.name AS brand, (SELECT count(*)::int FROM photos p WHERE p.car_id = c.id) AS have
       FROM cars c JOIN brands b ON b.id = c.brand_id
       WHERE (SELECT count(*) FROM photos p WHERE p.car_id = c.id) < $2 AND (c.photo_searched_at IS NULL OR c.photo_searched_at < now() - interval '14 days')
       ORDER BY (SELECT count(*) FROM photos p WHERE p.car_id = c.id) = 0 DESC, c.published DESC, c.popularity DESC, c.id LIMIT $1`,
      [photoCars, photosPerCar],
    );
    if (need.length) log(`Writing  looking for free photos of ${need.length} cars (up to ${photosPerCar} each, tagged by colour)`);
    for (const [i, car] of need.entries()) {
      if (halted()) return out;
      const label = `${car.brand} ${car.name}`;
      log(`Processing  [${i + 1}/${need.length}] ${label} (${car.have} photos so far)`);
      try {
        const r = await topUpPhotos(car, { target: photosPerCar, log });
        const retagged = await tagCarPhotos(car.id);
        if (r.added) {
          out.photoCars++;
          out.photos += r.added;
          touched.add(car.id);
          log(`Saved  [${i + 1}/${need.length}] ${label}: ${r.added} new photos, ${r.tagged + retagged} with a colour`);
        } else log(`Dropped  [${i + 1}/${need.length}] ${label}: no more free photos of this exact car on Commons${retagged ? ` (${retagged} existing photos got a colour)` : ""}`);
      } catch (err) {
        log(`ERROR  [${i + 1}/${need.length}] ${label}: ${String(err.message).slice(0, 100)}`);
      }
    }
  }

  // 5. Buying-guide copy (angle, pros, cons, overview, FAQs) for cars that have a photo, a price and
  // variants but not the copy the website's pages need. Cars waiting to go live come first.
  const guided = new Set();
  if (aiOverviews > 0 && aiStatus().some((p) => p.configured)) {
    const todo = await rows(
      `SELECT c.id, b.name || ' ' || c.name AS label FROM cars c JOIN brands b ON b.id = c.brand_id
       WHERE COALESCE(c.min_price, 0) > 0 AND EXISTS (SELECT 1 FROM photos p WHERE p.car_id = c.id) AND EXISTS (SELECT 1 FROM variants v WHERE v.car_id = c.id)
         AND (cardinality(c.pros) < 3 OR cardinality(c.cons) < 2 OR COALESCE(c.angle, '') = '' OR jsonb_array_length(c.overview) = 0)
       ORDER BY c.published ASC, c.popularity DESC LIMIT $1`,
      [aiOverviews],
    );
    let misses = 0;
    for (const [i, car] of todo.entries()) {
      if (halted()) return out;
      log(`Writing  [${i + 1}/${todo.length}] buying guide for ${car.label}`);
      try {
        await writeCarPageCopy(null, car.id);
        out.copies++;
        guided.add(car.id);
        misses = 0;
        log(`Saved  [${i + 1}/${todo.length}] ${car.label} guide`);
      } catch (err) {
        log(`ERROR  [${i + 1}/${todo.length}] ${car.label}: ${String(err.message).slice(0, 100)}`);
        if (++misses >= 2) {
          log("Writing  the AI is not answering, so the rest wait for the next run");
          break;
        }
      }
    }
  }

  // 6. A car goes on the website only when every page of it can be drawn: a photo, a price, variants,
  // at least one colour, and the guide copy (angle, 3 pros, 2 cons). Anything less stays hidden.
  const candidates = [...new Set([...touched, ...guided])];
  if (candidates.length) {
    const shown = await rows(
      `UPDATE cars c SET published = true, updated_at = now()
       WHERE c.id = ANY($1) AND NOT c.published AND COALESCE(c.min_price, 0) > 0
         AND EXISTS (SELECT 1 FROM photos p WHERE p.car_id = c.id) AND EXISTS (SELECT 1 FROM variants v WHERE v.car_id = c.id)
         AND jsonb_array_length(c.colors) > 0 AND cardinality(c.pros) >= 3 AND cardinality(c.cons) >= 2 AND COALESCE(c.angle, '') <> ''
       RETURNING c.id, c.name`,
      [candidates],
    );
    out.shown = shown.length;
    if (shown.length) log(`Saved  ${shown.length} cars are now on the website: ${shown.slice(0, 6).map((s) => s.name).join(", ")}${shown.length > 6 ? " ..." : ""}`);
  }
  const waiting = await rows(
    `SELECT c.name, ARRAY_REMOVE(ARRAY[
         CASE WHEN jsonb_array_length(c.colors) = 0 THEN 'colours' END,
         CASE WHEN cardinality(c.pros) < 3 OR cardinality(c.cons) < 2 OR COALESCE(c.angle, '') = '' THEN 'guide' END], NULL) AS missing
     FROM cars c WHERE NOT c.published AND COALESCE(c.min_price, 0) > 0
       AND EXISTS (SELECT 1 FROM photos p WHERE p.car_id = c.id) AND EXISTS (SELECT 1 FROM variants v WHERE v.car_id = c.id)
       AND (jsonb_array_length(c.colors) = 0 OR cardinality(c.pros) < 3 OR cardinality(c.cons) < 2 OR COALESCE(c.angle, '') = '')`,
  );
  if (waiting.length) log(`Cleaned  ${waiting.length} cars have a photo, price and variants but stay hidden until they have ${[...new Set(waiting.flatMap((w) => w.missing))].join(" and ")}: ${waiting.slice(0, 5).map((w) => w.name).join(", ")}${waiting.length > 5 ? " ..." : ""}`);

  if (out.created || out.updated || out.imagesAdded || out.shown || out.photos || out.copies) await contentChanged();
  log(`Done - ${out.created} new cars, ${out.updated} updated, ${out.photos + out.imagesAdded} photos, ${out.shown} on the website, ${out.copies} guides, ${out.failed} failed`);
  return out;
}
