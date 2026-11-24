// Copies a remote photo (e.g. from Wikimedia Commons) into the CMS's own
// uploads as a compressed WebP. Self-hosted photos can be resized per screen by
// the website (smaller downloads, better LCP), and Wikimedia asks re-users not
// to hotlink at scale. The credit, licence and source page stay with the photo.
import { mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { config } from "../config.js";
import { rows, query } from "../db.js";
import { fetchWithRetry } from "./http.js";
import { slugify } from "./text.js";

export const isOwnUpload = (src) => String(src).startsWith(`${config.cmsUrl}/uploads/`);

export async function localizeImage(src, nameHint = "photo") {
  const res = await fetchWithRetry(src, { timeout: 60000, tries: 3 });
  if (!res.ok) throw new Error(`${res.status} for ${src}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = path.join(config.uploadDir, "cars");
  mkdirSync(dir, { recursive: true });
  const filename = `${slugify(nameHint).slice(0, 60) || "photo"}-${Date.now().toString(36)}.webp`;
  const out = await sharp(buf).rotate().resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 78 }).toFile(path.join(dir, filename));
  return { src: `${config.cmsUrl}/uploads/cars/${filename}`, w: out.width, h: out.height, bytes: out.size, buffer: buf };
}

/** Moves every hotlinked car or site photo into uploads, one at a time (polite to the source). */
export async function localizeAll({ log = () => {} } = {}) {
  const list = await rows(
    "SELECT p.id, p.src, p.kind, COALESCE(b.slug || '-' || c.slug, p.site_key) AS name FROM photos p LEFT JOIN cars c ON c.id = p.car_id LEFT JOIN brands b ON b.id = c.brand_id WHERE p.src LIKE 'http%' AND p.src NOT LIKE $1 ORDER BY p.id",
    [`${config.cmsUrl}/uploads/%`],
  );
  let done = 0;
  let failed = 0;
  for (const p of list) {
    try {
      const img = await localizeImage(p.src, `${p.name}-${p.kind}`);
      await query("UPDATE photos SET src = $2, w = $3, h = $4 WHERE id = $1", [p.id, img.src, img.w, img.h]);
      done++;
      if (done % 10 === 0) log(`${done} of ${list.length} photos copied.`);
    } catch (err) {
      failed++;
      log(`Photo ${p.id} skipped: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  log(`Copied ${done} photos${failed ? `, ${failed} failed (run again to retry)` : ""}.`);
  return { total: list.length, done, failed };
}
