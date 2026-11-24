// The data behind the SEO tab: one card per page of the website with what Google sees today
// (read from the live page), a score, and the quick-save / auto-fix actions.
import { config } from "../config.js";
import { one, query, rows } from "../db.js";
import { fillArticle } from "./autofill.js";
import { pickForPath } from "./keywords.js";
import { readPage } from "./paths.js";
import { labelFor, suggestSeo } from "./seo-auto.js";

export const PAGE_SIZE = 24;
const LIVE_TTL = 30_000;
const live = new Map(); // path -> { at, page }

export const forgetLive = (path) => (path ? live.delete(path) : live.clear());

async function readLive(path) {
  const hit = live.get(path);
  if (hit && Date.now() - hit.at < LIVE_TTL) return hit.page;
  let page = null;
  try {
    const r = await fetch(`${config.siteUrl}${path}`, { signal: AbortSignal.timeout(8000), redirect: "manual" });
    if (r.ok) page = readPage(await r.text());
  } catch {
    page = null;
  }
  live.set(path, { at: Date.now(), page });
  return page;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

const articlePath = (a) => `${a.kind === "news" ? "/news" : a.kind === "review" ? "/expert-reviews" : "/tips-advice"}/${a.slug}`;

/** Everything the cards need that lives in the CMS database. */
export async function loadContext() {
  const [overrides, bank, articles] = await Promise.all([
    rows("SELECT path, title, description, noindex, keywords FROM seo_pages"),
    rows("SELECT phrase, priority, target_path FROM keywords WHERE target_path IS NOT NULL"),
    rows("SELECT id, kind, slug, title, excerpt, seo, keywords, image_src, cover_src, og_src, no_index FROM articles"),
  ]);
  return {
    overrides: new Map(overrides.map((o) => [o.path, o])),
    bank,
    articles: new Map(articles.map((a) => [articlePath(a), a])),
  };
}

/** Some headings are written twice in the HTML (a visible copy and a screen-reader copy): keep one. */
const halve = (s) => {
  const t = String(s ?? "").trim();
  const h = t.length / 2;
  return t && Number.isInteger(h) && t.slice(0, h) === t.slice(h) ? t.slice(0, h) : t || null;
};
const inRange =(s, lo, hi) => s.length >= lo && s.length <= hi;

/** One card: the page's current Google snippet, keywords, image and a score. */
export async function inspect(p, ctx, assume = null) {
  const art = ctx.articles.get(p.path) ?? null;
  const over = ctx.overrides.get(p.path) ?? null;
  const read = await readLive(p.path);
  // Right after a save the website has not caught up yet: judge the values that were just saved.
  const page = read && assume ? { ...read, title: assume.title || read.title, description: assume.description || read.description } : read;
  const bank = ctx.bank.filter((k) => k.target_path === p.path || p.path.startsWith(`${k.target_path}/`));
  const picked = bank.length ? pickForPath(bank, p.path) : null;
  const keywords = (art?.keywords?.length ? art.keywords : over?.keywords?.length ? over.keywords : picked ? [picked.primary, ...picked.secondary].filter(Boolean) : []).slice(0, 12);
  const title = page?.title ?? art?.seo?.title ?? over?.title ?? "";
  const description = page?.description ?? art?.seo?.description ?? over?.description ?? "";
  const withImage = p.group === "Articles" || p.group === "Car pages" || p.group === "Car tabs";
  const checks = {
    title: Boolean(title) && inRange(title, 30, 60) && title !== page?.h1,
    description: inRange(description, 120, 160),
    keywords: keywords.length > 0,
    ...(withImage ? { image: Boolean(page?.image || art?.cover_src || art?.image_src) } : {}),
  };
  const vals = Object.values(checks);
  return {
    path: p.path,
    group: p.group,
    name: p.car ? `${p.car}${p.group === "Car tabs" ? ` · ${p.path.split("/").pop()}` : ""}` : (art?.title ?? labelFor(p.path) ?? halve(page?.h1) ?? p.path),
    title,
    description,
    h1: page?.h1 ?? art?.title ?? "",
    keywords,
    noindex: Boolean(over?.noindex || art?.no_index),
    own: Boolean(art), // saved on the article itself instead of the page overrides
    reachable: Boolean(page),
    checks,
    score: Math.round((vals.filter(Boolean).length / vals.length) * 100),
  };
}

export const inspectMany = (list, ctx) => pool(list, 6, (p) => inspect(p, ctx));

/** The card for one path, optionally judging freshly saved values instead of the live page. */
export async function cardFor(path, snap, assume = null) {
  const { sitePaths } = await import("./paths.js");
  const p = sitePaths(snap).find((q) => q.path === path) ?? { path, group: "Main pages" };
  return inspect(p, await loadContext(), assume);
}

/** Saves an editor's values for one path. Articles keep them on the article; every other page uses the override table. */
export async function saveSeo(path, { title, description, keywords, noindex }) {
  const art = await one("SELECT id, seo FROM articles WHERE ($1 = '/news/' || slug AND kind = 'news') OR ($1 = '/expert-reviews/' || slug AND kind = 'review') OR ($1 = '/tips-advice/' || slug AND kind = 'advice')", [path]);
  const kw = [...new Set((keywords ?? []).map((k) => String(k).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  const t = String(title ?? "").trim().slice(0, 120);
  const d = String(description ?? "").trim().slice(0, 320);
  if (art) {
    await query("UPDATE articles SET seo = $2::jsonb, keywords = $3::jsonb, no_index = $4, updated_at = now() WHERE id = $1", [art.id, JSON.stringify({ ...art.seo, title: t, description: d }), JSON.stringify(kw), Boolean(noindex)]);
  } else if (!t && !d && !kw.length && !noindex) {
    await query("DELETE FROM seo_pages WHERE path = $1", [path]);
  } else {
    await query(
      "INSERT INTO seo_pages (path, title, description, noindex, keywords, updated_at) VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (path) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, noindex=EXCLUDED.noindex, keywords=EXCLUDED.keywords, updated_at=now()",
      [path, t || null, d || null, Boolean(noindex), JSON.stringify(kw)],
    );
  }
  forgetLive(path);
}

/** A suggestion for one page, without saving it. */
export async function suggestFor(path, snap) {
  const ctx = await loadContext();
  const art = ctx.articles.get(path);
  if (art) {
    const row = { title: art.title, excerpt: art.excerpt, category: "", keywords: [], tags: ["x"], seo: {} };
    fillArticle(row, {});
    return { title: row.seo.title, description: row.seo.description, keywords: art.keywords?.length ? art.keywords : row.keywords };
  }
  const { sitePaths } = await import("./paths.js");
  const p = sitePaths(snap).find((q) => q.path === path);
  return p ? suggestSeo(p, snap) : null;
}

/** Fixes what is missing or out of range on the given pages, leaving everything that is already fine. */
export async function autoFix(paths, snap) {
  const ctx = await loadContext();
  const all = new Map();
  const { sitePaths } = await import("./paths.js");
  for (const s of sitePaths(snap)) all.set(s.path, s);
  let fixed = 0;
  for (const path of paths) {
    const p = all.get(path);
    if (!p) continue;
    const card = await inspect(p, ctx);
    const art = ctx.articles.get(path);
    if (art) {
      // Blank the fields that are out of range so the article's own filler writes new ones.
      const row = { ...art, keywords: art.keywords ?? [], seo: { ...(art.seo ?? {}) } };
      if (!card.checks.title) row.seo.title = "";
      if (!card.checks.description) row.seo.description = "";
      const set = fillArticle(row, {});
      if (!Object.keys(set).length) continue;
      await query("UPDATE articles SET seo = $2::jsonb, keywords = $3::jsonb WHERE id = $1", [art.id, JSON.stringify(row.seo), JSON.stringify(row.keywords)]);
    } else {
      const sug = card.reachable ? suggestSeo(p, snap) : null; // never guess while the live page cannot be read
      if (!sug) continue;
      const over = ctx.overrides.get(path);
      const next = {
        title: card.checks.title ? over?.title : sug.title,
        description: card.checks.description ? over?.description : sug.description,
        keywords: card.checks.keywords ? (over?.keywords ?? []) : sug.keywords,
        noindex: over?.noindex ?? false,
      };
      if (next.title === over?.title && next.description === over?.description && JSON.stringify(next.keywords) === JSON.stringify(over?.keywords ?? [])) continue;
      await saveSeo(path, next);
    }
    forgetLive(path);
    fixed++;
  }
  return fixed;
}
