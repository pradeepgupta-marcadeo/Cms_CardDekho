// CarScrapper "360 view": copies CarWale's studio 360 frames (and the six faces of the cabin panorama) (read by `scrape.py --threesixty` into threesixty.jsonl)
// into uploads/carwale360/<brand>/<model>/<view>-<colour>-<version>/, so the website serves them itself. The frames
// keep CarWale's watermark, as CarWale's own player shows them. A view whose frames are already copied is skipped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { config } from "../config.js";
import { one, query, rows } from "../db.js";
import { contentChanged } from "./publish.js";

export const SPIN_CREDIT = "CarWale";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "x";

async function fetchFrame(url) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "image/webp,image/*,*/*;q=0.8", referer: "https://www.carwale.com/" }, signal: AbortSignal.timeout(30000) });
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

/** The newest record per car from threesixty.jsonl. */
export function readSpins(dataDir) {
  const file = path.join(dataDir, "threesixty.jsonl");
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const r = JSON.parse(line);
      if (r?.slug) out.set(r.slug, r);
    } catch {
      // a half-written line is skipped
    }
  }
  return out;
}

/** Copies the frames of every car's 360 views. opts: { brand, limit }. */
export async function importSpins(ctx, dataDir, { brand = null, limit = null } = {}) {
  const recs = [...readSpins(dataDir).values()].filter((r) => r.found && (!brand || r.slug.startsWith(`${brand}/`)));
  const have = new Map((await rows("SELECT car_slug, kind, colour, version, status, jsonb_array_length(frames) AS n FROM car_spins")).map((r) => [`${r.car_slug}|${r.kind}`, r]));
  const todo = [];
  for (const r of recs) {
    for (const [kind, v] of Object.entries(r.views ?? {})) {
      const old = have.get(`${r.slug}|${kind}`);
      const images = v.frames ?? v.faces ?? [];
      if (!images.length) continue;
      if (old && old.status === "done" && (old.colour ?? "") === (v.colour ?? "") && old.version === v.version && old.n === images.length) continue;
      todo.push({ r, kind, v });
    }
  }
  const list = limit ? todo.slice(0, limit) : todo;
  ctx.log(`360 views: ${recs.length} cars have one (CarWale or CarDekho); ${list.length} views to copy (${todo.length - list.length} left for a later run).`);
  let done = 0;
  let failed = 0;
  for (const [i, { r, kind, v }] of list.entries()) {
    if (ctx.stopped()) break;
    ctx.progress(i, list.length);
    const [brandSlug, model] = r.slug.split("/");
    const images = v.frames ?? v.faces;
    const dirName = `${kind}-${safe(v.colour)}-${safe(v.version)}`;
    const dir = path.join(config.uploadDir, "carwale360", safe(brandSlug), safe(model), dirName);
    mkdirSync(dir, { recursive: true });
    const base = `${config.cmsUrl}/uploads/carwale360/${safe(brandSlug)}/${safe(model)}/${dirName}`;
    try {
      const frames = new Array(images.length);
      let size = null;
      // Four frames at a time: quick, and gentle on the source.
      for (let k = 0; k < images.length; k += 4) {
        await Promise.all(
          images.slice(k, k + 4).map(async (url, j) => {
            const n = k + j + 1;
            const file = path.join(dir, `${n}.webp`);
            if (!existsSync(file)) {
              const buf = await fetchFrame(url);
              // CarWale already serves WebP; anything else is converted.
              const meta = await sharp(buf).metadata();
              if (meta.format === "webp") writeFileSync(file, buf);
              else await sharp(buf).webp({ quality: 82 }).toFile(file);
              size ??= { w: meta.width, h: meta.height };
            }
            frames[k + j] = `${base}/${n}.webp`;
          }),
        );
      }
      size ??= await sharp(path.join(dir, "1.webp")).metadata().then((m) => ({ w: m.width, h: m.height }));
      await one(
        `INSERT INTO car_spins (car_slug, kind, source_page, colour, version, frames, w, h, meta, status, error, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'done',NULL,now())
         ON CONFLICT (car_slug, kind) DO UPDATE SET source_page = EXCLUDED.source_page, colour = EXCLUDED.colour, version = EXCLUDED.version, frames = EXCLUDED.frames,
           w = EXCLUDED.w, h = EXCLUDED.h, meta = EXCLUDED.meta, status = 'done', error = NULL, updated_at = now() RETURNING car_slug`,
        [r.slug, kind, r.page, v.colour ?? "", v.version, JSON.stringify(frames), size.w, size.h, v.start ? JSON.stringify({ start: v.start }) : null],
      );
      done += 1;
      ctx.change(`360      ${r.slug} | ${kind === "interior" ? `cabin panorama · ${frames.length} faces` : `${kind} doors · ${frames.length} frames`} (${size.w}x${size.h}) | NEW`);
    } catch (err) {
      failed += 1;
      await query(
        `INSERT INTO car_spins (car_slug, kind, source_page, colour, version, status, error) VALUES ($1,$2,$3,$4,$5,'failed',$6)
         ON CONFLICT (car_slug, kind) DO UPDATE SET status = CASE WHEN car_spins.status = 'done' THEN 'done' ELSE 'failed' END, error = EXCLUDED.error, updated_at = now()`,
        [r.slug, kind, r.page, v.colour ?? "", v.version, String(err.message).slice(0, 300)],
      );
      ctx.log(`360      ${r.slug} | ${kind === "interior" ? "cabin panorama" : `${kind} doors`}: not copied (${String(err.message).slice(0, 120)})`);
    }
  }
  ctx.progress(list.length, list.length);
  if (done) await contentChanged();
  ctx.log(`360 views: ${done} copied, ${failed} failed.`);
  return { done, failed };
}
