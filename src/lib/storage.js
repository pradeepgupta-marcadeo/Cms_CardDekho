// Where uploaded and copied images are kept. With SUPABASE_URL and SUPABASE_SERVICE_KEY set (needed on Vercel,
// which has no disk), files go to a public Supabase Storage bucket; otherwise they are written to the uploads folder
// and served by the CMS at /uploads. Paths are the same in both ("cardekho/bmw/x5-front-abc.webp"), so moving
// from one to the other only changes the start of each address.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const { url, key, bucket } = config.storage;
export const usesCloud = Boolean(url && key);

/** Public address of the folder all files live under (no trailing slash). */
export const publicBase = usesCloud ? `${url}/storage/v1/object/public/${bucket}` : `${config.cmsUrl}/uploads`;

/** Public address of a stored file. */
export const fileUrl = (rel) => `${publicBase}/${rel}`;

/** True for an address of a file this CMS stored (in the cloud bucket or the local uploads folder). */
export const isOwnFile = (src) => String(src).startsWith(`${publicBase}/`) || String(src).startsWith(`${config.cmsUrl}/uploads/`);

// New Supabase secret keys (sb_secret_...) go in the apikey header only; older service_role keys (a JWT) go in both.
export const authHeaders = key?.startsWith("sb_") ? { apikey: key } : { authorization: `Bearer ${key}`, apikey: key };

const encode = (rel) => rel.split("/").map(encodeURIComponent).join("/");

/** Saves a file and returns its public address. */
export async function putFile(rel, data, contentType) {
  if (!usesCloud) {
    const file = path.join(config.uploadDir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
    return fileUrl(rel);
  }
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${url}/storage/v1/object/${bucket}/${encode(rel)}`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": contentType, "x-upsert": "true", "cache-control": "max-age=31536000" },
        body: data,
        signal: AbortSignal.timeout(60000),
      });
      if (res.ok) return fileUrl(rel);
      last = new Error(`Storage answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  throw last;
}

/** True when a stored file exists. */
export async function hasFile(rel) {
  if (!usesCloud) return existsSync(path.join(config.uploadDir, rel));
  const res = await fetch(fileUrl(encode(rel)), { method: "HEAD", signal: AbortSignal.timeout(20000) }).catch(() => null);
  return Boolean(res?.ok);
}

/** The bytes of a stored file. */
export async function getFile(rel) {
  if (!usesCloud) return readFileSync(path.join(config.uploadDir, rel));
  const res = await fetch(fileUrl(encode(rel)), { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Storage answered ${res.status} for ${rel}`);
  return Buffer.from(await res.arrayBuffer());
}
