// Fills the blanks of an article so an editor never has to type them: image alt text and title, the detail
// banner, the social image, tags and the SEO fields. Anything already filled in is left exactly as it is.
import { query, rows } from "../db.js";

const STOP = new Set("a an the of in on at to for and or with from by is are was be as it its this that new will gets get after says say amid over into".split(" "));

/** Cuts text to at most `max` characters at a word boundary. */
function cut(text, max) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const part = t.slice(0, max + 1);
  const at = part.lastIndexOf(" ");
  return part.slice(0, at > max * 0.6 ? at : max).replace(/[\s,;:–-]+$/, "");
}

const words = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));

/** Main keyword and a few more, taken from the headline, category and car. */
export function keywordsFrom({ title, category, carName }) {
  const w = words(title);
  const out = [];
  if (carName) out.push(carName.toLowerCase());
  if (w.length >= 2) out.push(w.slice(0, 4).join(" "));
  for (let i = 0; i + 1 < w.length && out.length < 6; i += 2) out.push(`${w[i]} ${w[i + 1]}`);
  if (category && category !== "news") out.push(`${carName ? `${carName.toLowerCase()} ` : ""}${category}`);
  out.push("car news india");
  return [...new Set(out.map((k) => k.trim()).filter((k) => k.length > 3))].slice(0, 8);
}

/** Fills the empty fields of `a` (a form's values or a database row) and returns what changed. */
export function fillArticle(a, { carName = "" } = {}) {
  const set = {};
  const put = (k, v) => {
    if (v !== undefined && v !== null && v !== "" && (a[k] === undefined || a[k] === null || a[k] === "")) {
      a[k] = v;
      set[k] = v;
    }
  };
  const title = String(a.title ?? "").trim();

  // Listing image: alt text and title come from the headline.
  if (a.image_src) {
    put("image_alt", cut(title, 140));
    put("image_title", cut(title, 120));
  }
  // Detail banner: the same picture as the listing image, until someone uploads a wider one.
  if (!a.cover_src && a.image_src) {
    put("cover_src", a.image_src);
    put("cover_w", a.image_w);
    put("cover_h", a.image_h);
  }
  if (a.cover_src) {
    put("cover_alt", a.image_alt || cut(title, 140));
    put("cover_title", a.image_title || cut(title, 120));
  }
  // Social share image falls back to the banner.
  put("og_src", a.cover_src || a.image_src);

  // Keywords, then tags from them.
  const keywords = Array.isArray(a.keywords) ? a.keywords : [];
  if (!keywords.length) {
    const k = keywordsFrom({ title, category: a.category, carName });
    a.keywords = k;
    set.keywords = k;
  }
  if (!Array.isArray(a.tags) || !a.tags.length) {
    const t = [...new Set([...(a.keywords ?? []).slice(1), a.category, carName.toLowerCase()].map((x) => String(x ?? "").trim().toLowerCase()).filter((x) => x && x.length <= 40))].slice(0, 8);
    a.tags = t;
    set.tags = t;
  }

  // SEO title (30–60 characters) and meta description (120–160).
  const seo = { ...(a.seo ?? {}) };
  let changed = false;
  if (!String(seo.title ?? "").trim()) {
    // Never identical to the page heading (a guardrail): the brand goes on the end, the headline is shortened to fit.
    const lead = title.split(/\s*[:–—-]\s+/)[0];
    seo.title = `${lead.length >= 20 && lead.length <= 47 ? lead : cut(title, 47)} | Wheelora`;
    changed = true;
  }
  if (!String(seo.description ?? "").trim()) {
    let d = String(a.excerpt ?? "").replace(/\s+/g, " ").trim() || title;
    if (d.length < 120) d = `${d.replace(/[.\s]+$/, "")}. Read the full story on Wheelora for the details, prices and what it means for car buyers in India.`;
    seo.description = cut(d, 160);
    changed = true;
  }
  if (changed) {
    a.seo = seo;
    set.seo = seo;
  }
  return set;
}

/** Fills every existing article that still has blanks (or just one). Returns how many were changed. */
export async function backfillArticles(onlyId = null) {
  const list = await rows("SELECT a.*, c.name AS car_name, b.name AS brand_name FROM articles a LEFT JOIN cars c ON c.id = a.car_id LEFT JOIN brands b ON b.id = c.brand_id WHERE $1::int IS NULL OR a.id = $1::int", [onlyId]);
  let n = 0;
  for (const a of list) {
    const set = fillArticle(a, { carName: a.car_name ? `${a.brand_name ?? ""} ${a.car_name}`.trim() : "" });
    const cols = Object.keys(set);
    if (!cols.length) continue;
    const vals = cols.map((c) => (["keywords", "seo"].includes(c) ? JSON.stringify(set[c]) : set[c]));
    await query(`UPDATE articles SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`, [a.id, ...vals]);
    n++;
  }
  return n;
}
