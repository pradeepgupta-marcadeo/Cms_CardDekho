import { Router } from "express";
import { config } from "../config.js";
import { one, query, rows } from "../db.js";
import { suggestKeywords, writeSeoMeta } from "../lib/ai-writer.js";
import { pickForPath } from "../lib/keywords.js";
import { readPage, sitePaths } from "../lib/paths.js";
import { audit, contentChanged } from "../lib/publish.js";
import { checkSeo } from "../lib/seo-check.js";
import { PAGE_SIZE, autoFix, cardFor, forgetLive, inspectMany, loadContext, saveSeo, suggestFor } from "../lib/seo-manager.js";
import { buildSnapshot } from "../lib/snapshot.js";

export const seoRouter = Router();

const cleanPath = (p) => {
  const s = String(p ?? "").trim();
  if (!s.startsWith("/") || s.startsWith("//") || /[\s?#]/.test(s)) return null;
  return s.length > 1 ? s.replace(/\/$/, "") : s;
};

// The SEO tab: a card for every page, what Google sees today, and a quick editor.
const FILTERS = ["Main pages", "Articles", "Car pages", "Car tabs", "Brands", "Car lists", "News topics", "Comparisons"];

seoRouter.get("/", async (req, res) => {
  const snap = await buildSnapshot();
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const group = FILTERS.includes(req.query.group) ? req.query.group : "";
  const pageNo = Math.max(1, Number(req.query.page) || 1);
  const ctx = await loadContext();
  let list = sitePaths(snap);
  if (group) list = list.filter((p) => p.group === group);
  if (q) list = list.filter((p) => p.path.includes(q) || (p.car ?? "").toLowerCase().includes(q) || (ctx.articles.get(p.path)?.title ?? "").toLowerCase().includes(q));
  const total = list.length;
  const cards = await inspectMany(list.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE), ctx);
  res.render("seo", { title: "SEO", cards, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), pageNo, group, q, FILTERS });
});

// Quick save from the card editor (JSON).
seoRouter.post("/quick", async (req, res) => {
  const path = cleanPath(req.body.path);
  if (!path) return res.status(400).json({ error: "Bad page address." });
  const keywords = Array.isArray(req.body.keywords) ? req.body.keywords : String(req.body.keywords ?? "").split(/\r?\n|,/);
  await saveSeo(path, { title: req.body.title, description: req.body.description, keywords, noindex: req.body.noindex === true });
  await audit(req, "update", "seo", path, String(req.body.title ?? ""));
  await contentChanged();
  res.json({ ok: true, card: await cardFor(path, await buildSnapshot(), { title: String(req.body.title ?? "").trim(), description: String(req.body.description ?? "").trim() }) });
});

// Read-only: the card as the live page shows it now.
seoRouter.post("/card", async (req, res) => {
  const path = cleanPath(req.body.path);
  if (!path) return res.status(400).json({ error: "Bad page address." });
  forgetLive(path);
  res.json({ card: await cardFor(path, await buildSnapshot()) });
});

seoRouter.post("/suggest", async (req, res) => {
  const path = cleanPath(req.body.path);
  const s = path ? await suggestFor(path, await buildSnapshot()) : null;
  if (!s) return res.status(404).json({ error: "No automatic suggestion for this page." });
  res.json(s);
});

// Fixes what is missing or out of range on the pages shown (JSON). Only blanks and out-of-range values change.
seoRouter.post("/autofix", async (req, res) => {
  const paths = (Array.isArray(req.body.paths) ? req.body.paths : []).map(cleanPath).filter(Boolean).slice(0, 200);
  const fixed = await autoFix(paths, await buildSnapshot());
  if (fixed) {
    await audit(req, "auto-seo", "seo", "", `${fixed} page(s)`);
    await contentChanged();
  }
  res.json({ ok: true, fixed, checked: paths.length });
});

seoRouter.get("/edit", async (req, res) => {
  const path = cleanPath(req.query.path);
  if (!path) return res.redirect("/admin/seo");
  const override = (await one("SELECT * FROM seo_pages WHERE path = $1", [path])) ?? { path, title: "", description: "", noindex: false, keywords: [] };
  const bank = await rows("SELECT phrase, priority, target_path FROM keywords WHERE target_path = $1 ORDER BY priority, phrase", [path]);
  let live = null;
  let liveError = null;
  try {
    const r = await fetch(`${config.siteUrl}${path}`, { signal: AbortSignal.timeout(15000), redirect: "manual" });
    if (r.status >= 300 && r.status < 400) liveError = `This URL redirects (${r.status}) to ${r.headers.get("location")}. Edit the final URL instead.`;
    else if (!r.ok) liveError = `The website answered ${r.status} for this URL.`;
    else live = readPage(await r.text());
  } catch (err) {
    liveError = `Could not read the live page (${err.cause?.code ?? err.message}). Is the website running at ${config.siteUrl}?`;
  }
  const picked = pickForPath(bank, path);
  const kws = override.keywords?.length ? override.keywords : [picked.primary, ...picked.secondary].filter(Boolean);
  const seo = live ? checkSeo({ title: live.title, description: live.description, h1: live.h1, sections: live.sections, primary: kws[0], secondary: kws.slice(1), minWords: 300 }) : null;
  res.render("seo-edit", { title: `SEO: ${path}`, path, override, bank, live, liveError, seo, kws });
});

seoRouter.post("/edit", async (req, res) => {
  const path = cleanPath(req.body.path);
  if (!path) return res.redirect("/admin/seo");
  const keywords = String(req.body.keywords ?? "").split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const title = String(req.body.title ?? "").trim();
  const description = String(req.body.description ?? "").trim();
  const noindex = req.body.noindex === "on";
  if (!title && !description && !noindex && !keywords.length) await query("DELETE FROM seo_pages WHERE path = $1", [path]);
  else
    await query(
      "INSERT INTO seo_pages (path, title, description, noindex, keywords, updated_at) VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (path) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, noindex=EXCLUDED.noindex, keywords=EXCLUDED.keywords, updated_at=now()",
      [path, title || null, description || null, noindex, JSON.stringify(keywords)],
    );
  forgetLive(path);
  await audit(req, "update", "seo", path, `${title} | ${description}${noindex ? " | NOINDEX" : ""}`);
  await contentChanged();
  req.session.flash = { type: noindex ? "err" : "ok", text: noindex ? "Saved. Warning: this page is now hidden from Google (noindex) and removed from the sitemap." : "Saved. The website uses the new title and description in a few seconds." };
  res.redirect(`/admin/seo/edit?path=${encodeURIComponent(path)}`);
});

seoRouter.post("/ai", async (req, res) => {
  const path = cleanPath(req.body.path);
  try {
    const r = await fetch(`${config.siteUrl}${path}`, { signal: AbortSignal.timeout(15000) });
    const page = readPage(await r.text());
    const keywords = String(req.body.keywords ?? "").split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const meta = await writeSeoMeta({ path, h1: page.h1, text: page.sections[0].p.join(" "), primary: keywords[0] ?? "", secondary: keywords.slice(1) });
    await query(
      "INSERT INTO seo_pages (path, title, description, keywords, updated_at) VALUES ($1,$2,$3,$4,now()) ON CONFLICT (path) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, keywords=EXCLUDED.keywords, updated_at=now()",
      [path, meta.title, meta.description, JSON.stringify(keywords)],
    );
    await audit(req, "ai-seo", "seo", path, meta.provider);
    await contentChanged();
    req.session.flash = { type: "ok", text: `AI (${meta.provider}) wrote a new title and description and saved them. Check them below.` };
  } catch (err) {
    req.session.flash = { type: "err", text: err.message };
  }
  res.redirect(`/admin/seo/edit?path=${encodeURIComponent(path ?? "/")}`);
});

seoRouter.post("/keywords-ai", async (req, res) => {
  const path = cleanPath(req.body.path);
  try {
    const existing = (await rows("SELECT phrase FROM keywords WHERE target_path = $1", [path])).map((r) => r.phrase);
    const list = await suggestKeywords({ topic: String(req.body.topic || path), existing });
    let added = 0;
    for (const k of list) added += (await query("INSERT INTO keywords (phrase, intent, priority, target_path, source) VALUES ($1,$2,$3,$4,'ai') ON CONFLICT (phrase) DO NOTHING", [k.phrase, k.intent, k.priority, path])).rowCount;
    req.session.flash = { type: "ok", text: `AI suggested ${list.length} phrases; ${added} new ones were added to the keyword bank for this page.` };
  } catch (err) {
    req.session.flash = { type: "err", text: err.message };
  }
  res.redirect(`/admin/seo/edit?path=${encodeURIComponent(path ?? "/")}`);
});
