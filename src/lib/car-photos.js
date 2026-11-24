// Finds real photographs of a car on Wikimedia Commons (free licences, credited) and tells which of
// the car's colours each one shows. As many photos as exist are kept, up to a target per car.
import { query, rows } from "../db.js";
import { searchCommons } from "../importers/commons.js";
import { colourFromPixels, colourFromText, familiesOfColour, wordsFromCommonsPage } from "./colour-detect.js";
import { localizeImage } from "./localize.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
// Titles that are not a photograph of the real car.
const NOT_A_CAR_PHOTO = /\b(logo|badge|emblem|toy|model car|diecast|miniature|lego|scale model|render|sketch|drawing|engine bay|wheel only|brochure|poster|wrecked|accident|burnt|burned)\b/i;

export const paletteOf = (car) => (Array.isArray(car.colors) ? car.colors.filter((c) => c?.name) : []);

/** Colour words to add to a search, one per distinct colour family of the car. */
function colourQueries(car) {
  const words = [];
  const seen = new Set();
  for (const c of paletteOf(car)) {
    for (const f of familiesOfColour(c)) {
      if (!seen.has(f) && f !== "grey") {
        seen.add(f);
        words.push(f);
      }
    }
  }
  return words.slice(0, 5);
}

/**
 * Sets the colour of this car's exterior photos that have none, from the words around each photo and,
 * for vividly coloured cars, from its pixels. Returns how many photos got a colour.
 */
export async function tagCarPhotos(carId) {
  const car = (await rows("SELECT id, colors FROM cars WHERE id = $1", [carId]))[0];
  const palette = car ? paletteOf(car) : [];
  if (palette.length < 2) return 0; // with a single colour every photo would be "that colour": nothing to tell apart
  const todo = await rows("SELECT id, src, page, kind FROM photos WHERE car_id = $1 AND colour IS NULL AND colour_by = '' AND kind <> 'interior' AND kind <> 'detail'", [carId]);
  let tagged = 0;
  for (const p of todo) {
    let colour = colourFromText(wordsFromCommonsPage(p.page), palette);
    let by = "text";
    if (!colour) {
      try {
        const res = await fetch(p.src, { signal: AbortSignal.timeout(30000) });
        if (res.ok) {
          colour = await colourFromPixels(Buffer.from(await res.arrayBuffer()), palette);
          by = "pixels";
        }
      } catch {
        // an unreachable photo is simply left untagged
      }
    }
    await query("UPDATE photos SET colour = $2, colour_by = $3 WHERE id = $1", [p.id, colour, colour ? by : "checked"]);
    if (colour) tagged++;
  }
  return tagged;
}

/**
 * Adds free-licence photos of the car until it has `target`, spread over angles and colours.
 * Returns { added, tagged, found } and never throws on a missing photo.
 */
export async function topUpPhotos(car, { target = 12, log = () => {} } = {}) {
  const have = await rows("SELECT page, kind, colour FROM photos WHERE car_id = $1", [car.id]);
  const need = target - have.length;
  const out = { added: 0, tagged: 0, found: 0 };
  await query("UPDATE cars SET photo_searched_at = now() WHERE id = $1", [car.id]);
  if (need <= 0) return out;

  const label = `${car.brand} ${car.name}`;
  const palette = paletteOf(car);
  const queries = [label, `${car.name} ${car.brand} interior`, ...colourQueries(car).map((c) => `${label} ${c}`)];
  const pool = new Map();
  for (const q of queries) {
    try {
      for (const p of await searchCommons(q, { limit: 50 })) if (p.page && !pool.has(p.page)) pool.set(p.page, p);
    } catch (err) {
      log(`Fetching  ${q}: ${String(err.message).slice(0, 80)}`);
    }
    await sleep(1000); // Commons asks clients to go slowly
  }

  const full = norm(car.name);
  const first = norm(car.name.split(" ")[0]);
  const brand = norm(car.brand);
  const known = new Set(have.map((h) => h.page));
  const fits = [...pool.values()].filter((p) => {
    const t = norm(p.title.replace(/^File:/i, ""));
    return !known.has(p.page) && !NOT_A_CAR_PHOTO.test(p.title) && (t.includes(full) || (first.length >= 4 && t.includes(first) && (t.includes(brand) || full === first)));
  });
  out.found = fits.length;

  // Greedy pick: prefer a colour or angle the car does not have a photo of yet, then the biggest picture.
  const colours = new Map();
  const kinds = new Map();
  for (const h of have) {
    colours.set(h.colour, (colours.get(h.colour) ?? 0) + 1);
    kinds.set(h.kind, (kinds.get(h.kind) ?? 0) + 1);
  }
  const taken = [];
  const rest = fits.map((p) => ({ p, colour: p.kind === "interior" ? null : colourFromText(p.text, palette) }));
  while (taken.length < need && rest.length) {
    rest.sort((a, b) => {
      const score = (x) => (x.colour && (colours.get(x.colour) ?? 0) < 2 ? 3 : 0) + ((kinds.get(x.p.kind) ?? 0) < 3 ? 2 : 0) + (x.p.w ?? 0) / 4000;
      return score(b) - score(a);
    });
    const pick = rest.shift();
    taken.push(pick);
    if (pick.colour) colours.set(pick.colour, (colours.get(pick.colour) ?? 0) + 1);
    kinds.set(pick.p.kind, (kinds.get(pick.p.kind) ?? 0) + 1);
  }

  let sort = (await rows("SELECT COALESCE(max(sort), -1) + 1 AS n FROM photos WHERE car_id = $1", [car.id]))[0].n;
  for (const { p, colour } of taken) {
    let img = { src: p.src, w: p.w, h: p.h, buffer: null };
    try {
      img = await localizeImage(p.src, `car-${car.id}-${p.kind}`);
    } catch {
      // keep Commons' own address
    }
    let by = colour ? "text" : "";
    let tag = colour;
    if (!tag && p.kind !== "interior" && p.kind !== "detail" && img.buffer && palette.length >= 2) {
      tag = await colourFromPixels(img.buffer, palette);
      by = tag ? "pixels" : "checked";
    }
    await query("INSERT INTO photos (car_id, src, w, h, kind, credit, license, page, sort, colour, colour_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [car.id, img.src, img.w, img.h, p.kind, p.credit, p.license, p.page ?? "", sort++, tag, by]);
    out.added++;
    if (tag) out.tagged++;
  }
  return out;
}
