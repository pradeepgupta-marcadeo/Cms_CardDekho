// One-time move of the uploads folder to Supabase Storage, for going live on Vercel (no disk there).
//   1. Makes the public bucket if it is missing.
//   2. Uploads every file under uploads/ (same paths), skipping ones already there; safe to run again.
//   3. Rewrites image addresses in the database (DATABASE_URL) from "<CMS_URL>/uploads/..." to the bucket.
// Needs SUPABASE_URL and SUPABASE_SERVICE_KEY in .env. Run: node src/scripts/move-to-storage.js [--urls-only] [--compress]
//   --compress: only the files the database uses, re-encoded smaller (to fit Supabase's free 1GB): photos as WebP
//   quality 60 (at most 1280px wide), 360 frames 960px quality 55, cabin panorama faces 1280px quality 60.
//   The files in uploads/ are not changed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import sharp from "sharp";
import { pool, rows } from "../db.js";
import { authHeaders, publicBase, usesCloud } from "../lib/storage.js";

if (!usesCloud) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env first.");
  process.exit(1);
}
const { url, bucket } = config.storage;
const auth = authHeaders;
const TYPES = { ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".gif": "image/gif", ".avif": "image/avif" };

async function ensureBucket() {
  const res = await fetch(`${url}/storage/v1/bucket/${bucket}`, { headers: auth });
  if (res.ok) return console.log(`Bucket "${bucket}" is there.`);
  const made = await fetch(`${url}/storage/v1/bucket`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ id: bucket, name: bucket, public: true }) });
  if (!made.ok) throw new Error(`Could not make the bucket: ${made.status} ${await made.text()}`);
  console.log(`Bucket "${bucket}" made (public).`);
}

/** Every file already in the bucket (paths), read folder by folder. */
async function listBucket(prefix = "", out = new Set()) {
  for (let offset = 0; ; offset += 1000) {
    let items = null;
    let status = "no answer";
    for (let i = 0; i < 6 && !items; i++) {
      // A dropped connection (while asking or while reading the answer) is tried again after a short wait.
      if (i) await new Promise((r) => setTimeout(r, 2000 * i));
      try {
        const res = await fetch(`${url}/storage/v1/object/list/${bucket}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ prefix, limit: 1000, offset }) });
        status = res.status;
        if (res.ok) items = await res.json();
      } catch {
        status = "connection dropped";
      }
    }
    if (!items) throw new Error(`Could not list the bucket: ${status}`);
    for (const it of items) {
      const p = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.id) out.add(p);
      else await listBucket(p, out); // a folder
    }
    if (items.length < 1000) return out;
  }
}

function localFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) localFiles(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

const COMPRESS = process.argv.includes("--compress");

/** The file's bytes as uploaded: as they are, or (with --compress) re-encoded smaller. */
async function bytesOf(rel) {
  const raw = readFileSync(path.join(config.uploadDir, rel));
  if (!COMPRESS || !/\.(webp|jpe?g|png)$/i.test(rel)) return raw;
  const face = /^carwale360\/.+\/interior-/.test(rel);
  const frame = rel.startsWith("carwale360/") && !face;
  const [width, quality] = frame ? [960, 55] : [1280, 60];
  const out = await sharp(raw).resize({ width, withoutEnlargement: true }).webp({ quality }).toBuffer();
  return out.length < raw.length ? out : raw;
}

/** Paths under uploads/ that the database points at ("<CMS_URL>/uploads/<path>"). */
async function usedFiles() {
  const from = `${config.cmsUrl}/uploads/`;
  const cols = await rows(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb', 'json') AND table_name NOT IN ('session')`,
  );
  const found = new Set();
  for (const c of cols) {
    const col = `"${c.column_name}"`;
    const asText = c.data_type.startsWith("json") ? `${col}::text` : col;
    for (const r of await rows(`SELECT ${asText} AS v FROM "${c.table_name}" WHERE ${asText} LIKE '%' || $1 || '%'`, [from])) {
      // Each address runs from just after "<CMS_URL>/uploads/" up to the next quote, space or bracket.
      for (const part of String(r.v).split(from).slice(1)) {
        const rel = part.match(/^[^"'\s,)<>\\]+/)?.[0];
        if (rel) found.add(decodeURIComponent(rel));
      }
    }
  }
  return [...found];
}

async function upload(rel) {
  const type = COMPRESS && /\.(webp|jpe?g|png)$/i.test(rel) ? "image/webp" : (TYPES[path.extname(rel).toLowerCase()] ?? "application/octet-stream");
  const enc = rel.split("/").map(encodeURIComponent).join("/");
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${url}/storage/v1/object/${bucket}/${enc}`, {
      method: "POST",
      headers: { ...auth, "content-type": type, "x-upsert": "true", "cache-control": "max-age=31536000" },
      body: await bytesOf(rel),
      signal: AbortSignal.timeout(120000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
    if (res.ok) return true;
    if (i === 3) console.log(`  failed ${rel}: ${res.status} ${(await res.text()).slice(0, 150)}`);
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  return false;
}

async function moveFiles() {
  const all = COMPRESS ? (await usedFiles()).filter((f) => existsSync(path.join(config.uploadDir, f))) : localFiles(config.uploadDir);
  const have = await listBucket();
  const todo = all.filter((f) => !have.has(f));
  console.log(`${all.length} files in uploads, ${have.size} already in the bucket, ${todo.length} to upload.`);
  let done = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const f = todo[next++];
      if (await upload(f)) done++;
      else failed++;
      if ((done + failed) % 500 === 0) console.log(`  ${done + failed} / ${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  console.log(`Uploaded ${done}, failed ${failed}.`);
  return failed;
}

/** Rewrites "<CMS_URL>/uploads/" to the bucket address in every text and JSON column of the database. */
async function rewriteUrls() {
  const from = `${config.cmsUrl}/uploads/`;
  const to = `${publicBase}/`;
  const cols = await rows(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb', 'json') AND table_name NOT IN ('session')`,
  );
  let total = 0;
  for (const c of cols) {
    const col = `"${c.column_name}"`;
    const asText = c.data_type.startsWith("json") ? `${col}::text` : col;
    const set = c.data_type.startsWith("json") ? `replace(${col}::text, $1, $2)::${c.data_type}` : `replace(${col}, $1, $2)`;
    const r = await pool.query(`UPDATE "${c.table_name}" SET ${col} = ${set} WHERE ${asText} LIKE '%' || $1 || '%'`, [from, to]);
    if (r.rowCount) console.log(`  ${c.table_name}.${c.column_name}: ${r.rowCount} rows`);
    total += r.rowCount;
  }
  console.log(`Image addresses rewritten in ${total} rows (${from} -> ${to}).`);
}

await ensureBucket();
const failed = process.argv.includes("--urls-only") ? 0 : await moveFiles();
if (failed) console.log("Some files failed: run this again (it skips what is already uploaded) before the addresses are rewritten.");
else await rewriteUrls();
await pool.end();
