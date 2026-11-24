// Finds the picture that belongs to a news story, checks it is a real photograph, and saves a
// copy on our server (resized, WebP) so the article never depends on the publisher's server.
//
// Order of preference: the story page's own social image (og:image), then the picture the feed
// offered. A story with no usable picture is not written at all.
import sharp from "sharp";
import { allowedByRobots, isImageUrl } from "../importers/news.js";
import { fetchWithRetry } from "./http.js";
import { slugify } from "./text.js";
import { saveImage } from "../routes/media.js";

const MIN_WIDTH = 600;
const MIN_BYTES = 4 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;

// Logos, icons, tracking pixels and placeholders are never a story's photograph.
const JUNK = /(favicon|sprite|\/logo|logo[-_.]|[-_/]logo\b|placeholder|default[-_.]?(image|img|thumb)?\.|blank|spacer|pixel|1x1|avatar|gravatar|emoji|icon[-_.]|badge|banner-ad|\/ads?\/)/i;

/** Asks for the large version of an image where the URL pattern says how (WordPress, ?w=, ?width=). */
export function upsize(url) {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/-\d{2,4}x\d{2,4}(\.\w{3,4})$/i, "$1"); // WordPress thumbnail suffix
    for (const key of ["w", "width"]) if (u.searchParams.has(key) && Number(u.searchParams.get(key)) < 1200) u.searchParams.set(key, "1600");
    for (const key of ["h", "height", "resize", "fit", "crop"]) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return url;
  }
}

const absolute = (href, base) => {
  try {
    return new URL(href.replace(/&amp;/g, "&"), base).toString();
  } catch {
    return null;
  }
};

/** The social-share image a story page names, or null. Respects robots.txt like every page read. */
export async function pageImage(url) {
  try {
    if (!(await allowedByRobots(url))) return null;
    const res = await fetchWithRetry(url, { timeout: 15000, tries: 1, headers: { accept: "text/html" } });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 300000);
    const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
    for (const prop of ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]) {
      const tag = metas.find((t) => new RegExp(`(property|name)=["']${prop}["']`, "i").test(t));
      const content = tag?.match(/content=["']([^"']+)["']/i)?.[1];
      if (content) return absolute(content, url);
    }
    const ld = html.match(/"image"\s*:\s*(?:\[\s*)?(?:\{[^}]*"url"\s*:\s*)?"(https?:[^"]+)"/i)?.[1];
    return ld ? absolute(ld.replace(/\\\//g, "/"), url) : null;
  } catch {
    return null;
  }
}

/** Downloads one candidate. Returns { buffer, mime } or a reason string. */
async function download(url) {
  let res;
  try {
    // No Referer on purpose: several publishers refuse an image request that names another site.
    res = await fetchWithRetry(url, { timeout: 25000, tries: 2, headers: { accept: "image/avif,image/webp,image/*,*/*;q=0.8", "user-agent": "Mozilla/5.0 (compatible; WheeloraNewsDesk/1.0)" } });
  } catch (err) {
    return `could not download (${err.message})`;
  }
  if (!res.ok) return `HTTP ${res.status}`;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < MIN_BYTES) return "too small to be a photograph";
  if (buffer.length > MAX_BYTES) return "larger than 8 MB";
  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    return "not an image";
  }
  if (!["jpeg", "png", "webp", "avif", "gif"].includes(meta.format)) return `unsupported format ${meta.format}`;
  if ((meta.width ?? 0) < MIN_WIDTH) return `only ${meta.width}px wide`;
  if (meta.height && meta.width && meta.width / meta.height > 4) return "a banner, not a photograph";
  return { buffer, mime: `image/${meta.format === "jpeg" ? "jpeg" : meta.format}` };
}

/**
 * Saves the first usable picture from `candidates` and returns { src, w, h, alt, credit }.
 * Returns null when none works; `why` collects the reasons for the log.
 */
export async function storeStoryImage({ candidates, title, credit, why = [] }) {
  const tried = new Set();
  for (const raw of candidates.filter(Boolean)) {
    for (const url of [upsize(raw), raw]) {
      if (tried.has(url) || !isImageUrl(url)) continue;
      tried.add(url);
      if (JUNK.test(new URL(url).pathname)) {
        why.push(`${new URL(url).hostname}: looks like a logo or placeholder`);
        continue;
      }
      const got = await download(url);
      if (typeof got === "string") {
        why.push(`${new URL(url).hostname}: ${got}`);
        continue;
      }
      const saved = await saveImage({ buffer: got.buffer, originalname: `${slugify(title).slice(0, 60) || "news"}.jpg`, mimetype: got.mime, size: got.buffer.length }, { alt: title, credit });
      return { src: saved.url, w: saved.w, h: saved.h, alt: title, credit };
    }
  }
  return null;
}
