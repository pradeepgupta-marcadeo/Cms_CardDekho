// One-time move of the uploads folder to Supabase Storage, for going live on Vercel (no disk there).
//   1. Makes the public bucket if it is missing.
//   2. Uploads every file under uploads/ (same paths), skipping ones already there; safe to run again.
//   3. Rewrites image addresses in the database (DATABASE_URL) from "<CMS_URL>/uploads/..." to the bucket.
// Needs SUPABASE_URL and SUPABASE_SERVICE_KEY in .env. Run: node src/scripts/move-to-storage.js [--urls-only]
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
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
    const res = await fetch(`${url}/storage/v1/object/list/${bucket}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ prefix, limit: 1000, offset }) });
    if (!res.ok) throw new Error(`Could not list the bucket: ${res.status}`);
    const items = await res.json();
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

async function upload(rel) {
  const type = TYPES[path.extname(rel).toLowerCase()] ?? "application/octet-stream";
  const enc = rel.split("/").map(encodeURIComponent).join("/");
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${url}/storage/v1/object/${bucket}/${enc}`, {
      method: "POST",
      headers: { ...auth, "content-type": type, "x-upsert": "true", "cache-control": "max-age=31536000" },
      body: readFileSync(path.join(config.uploadDir, rel)),
      signal: AbortSignal.timeout(120000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
    if (res.ok) return true;
    if (i === 3) console.log(`  failed ${rel}: ${res.status} ${(await res.text()).slice(0, 150)}`);
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  return false;
}

async function moveFiles() {
  const all = localFiles(config.uploadDir);
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
