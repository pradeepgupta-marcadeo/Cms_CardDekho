import { Router } from "express";
import { one, query, rows } from "../db.js";
import { writeSeoMeta } from "../lib/ai-writer.js";
import { draftAdvice, draftReview } from "../lib/drafts.js";
import { checkSeo } from "../lib/seo-check.js";
import { audit, contentChanged } from "../lib/publish.js";
import { addRedirect } from "../lib/redirects.js";
import { countWords, slugify } from "../lib/text.js";
import { friendly } from "./crud.js";
import multer from "multer";
import { config } from "../config.js";
import { storeStoryImage } from "../lib/news-image.js";
import { DESK } from "../lib/authors.js";
import { fillArticle } from "../lib/autofill.js";
import { isOwnUpload } from "../lib/localize.js";
import { cleanHtml, htmlToSections, sectionsToHtml } from "../lib/rich.js";
import { saveImage } from "./media.js";
import { aiStatus } from "../lib/ai.js";
import { runNewsScrape, SCRAPE_CATEGORIES } from "../lib/news-scraper.js";

export const articlesRouter = Router();

const KINDS = { news: "News", review: "Expert review", advice: "Tips & advice" };
export const articlePath = (a) => `${a.kind === "news" ? "/news" : a.kind === "review" ? "/expert-reviews" : "/tips-advice"}/${a.slug}`;
const authorList = () => rows("SELECT id, name, active FROM authors ORDER BY active DESC, name");
const BASE_CATEGORIES = ["news", "launch", "pricing", "discount", "safety", "sales", "spy", "comparison", "expert review", "guide"];
const categoryList = async (current) => {
  const used = (await rows("SELECT DISTINCT category FROM articles WHERE category <> ''")).map((r) => r.category);
  return [...new Set([...BASE_CATEGORIES, ...used, current].filter(Boolean))];
};
const carOptions = () => rows("SELECT c.id, b.name || ' ' || c.name AS label FROM cars c JOIN brands b ON b.id = c.brand_id ORDER BY b.name, c.name");
const faqsToText = (faqs) => (faqs ?? []).map((f) => `Q: ${f.q}\nA: ${f.a}`).join("\n\n");
const faqsFromText = (t) =>
  String(t ?? "").replace(/\r/g, "").split(/\n\s*\n/).map((b) => {
    const q = b.match(/^Q:\s*(.+)$/m)?.[1]?.trim();
    const a = b.match(/^A:\s*([\s\S]+)$/m)?.[1]?.trim().replace(/\n/g, " ");
    return q && a ? { q, a } : null;
  }).filter(Boolean);

const DATE_FIELDS = { created_at: "a.created_at", published_on: "a.published_on", updated_at: "a.updated_at" };
const SORTS = { title: "a.title", created_at: "a.created_at", published_on: "a.published_on", updated_at: "a.updated_at" };

articlesRouter.get("/", async (req, res) => {
  const kind = KINDS[req.query.kind] ? req.query.kind : "";
  const status = ["draft", "published"].includes(req.query.status) ? req.query.status : "";
  const q = String(req.query.q ?? "").trim();
  const source = String(req.query.source ?? "").trim();
  const category = String(req.query.category ?? "").trim().toLowerCase();
  const per = [25, 50, 100, 200].includes(Number(req.query.limit)) ? Number(req.query.limit) : 25;
  const page = Math.max(1, Number(req.query.page) || 1);
  const dateField = DATE_FIELDS[req.query.dateField] ? req.query.dateField : "created_at";
  const sortKey = String(req.query.sort ?? "-created_at");
  const desc = sortKey.startsWith("-");
  const sortCol = SORTS[sortKey.replace(/^-/, "")] ? sortKey.replace(/^-/, "") : "created_at";
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ""));
  const from = isDate(req.query.from) ? req.query.from : "";
  const to = isDate(req.query.to) ? req.query.to : "";
  const where = [];
  const params = [];
  if (kind) where.push(`a.kind = $${params.push(kind)}`);
  if (status) where.push(`a.status = $${params.push(status)}`);
  if (category) where.push(`a.category = $${params.push(category)}`);
  if (source === "__hand") where.push("a.source IS NULL");
  else if (source) where.push(`a.source->>'name' = $${params.push(source)}`);
  if (req.query.car) where.push(`a.car_id = $${params.push(Number(req.query.car))}`);
  if (req.query.demo === "1") where.push("a.is_demo");
  if (from) where.push(`${DATE_FIELDS[dateField]}::date >= $${params.push(from)}`);
  if (to) where.push(`${DATE_FIELDS[dateField]}::date <= $${params.push(to)}`);
  if (q) {
    const n = params.push(`%${q}%`);
    where.push(`(a.title ILIKE $${n} OR a.excerpt ILIKE $${n})`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const matched = (await one(`SELECT count(*)::int AS n FROM articles a ${clause}`, params)).n;
  const list = await rows(
    `SELECT a.id, a.kind, a.slug, a.title, a.excerpt, a.status, a.published_on, a.created_at, a.updated_at, a.ai_generated, a.is_demo, a.seo, a.category, a.source,
       b.name || ' ' || c.name AS car,
       COALESCE(a.image_src, (SELECT p.src FROM photos p WHERE p.car_id = COALESCE(a.photo_car_id, a.car_id) ORDER BY p.sort, p.id LIMIT 1)) AS thumb
     FROM articles a LEFT JOIN cars c ON c.id = a.car_id LEFT JOIN brands b ON b.id = c.brand_id
     ${clause} ORDER BY ${SORTS[sortCol]} ${desc ? "DESC" : "ASC"}, a.id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`,
    params,
  );
  const totals = await one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'published')::int AS published, count(*) FILTER (WHERE status = 'draft')::int AS drafts FROM articles ${kind ? "WHERE kind = $1" : ""}`, kind ? [kind] : []);
  const byKind = Object.fromEntries((await rows("SELECT kind, count(*)::int AS n FROM articles GROUP BY kind")).map((r) => [r.kind, r.n]));
  const categories = await rows("SELECT category, count(*)::int AS n FROM articles WHERE category <> '' GROUP BY category ORDER BY n DESC, category");
  const sources = await rows("SELECT DISTINCT source->>'name' AS name FROM articles WHERE source IS NOT NULL AND source->>'name' <> '' ORDER BY 1");
  const leads = await one("SELECT count(*)::int AS n FROM news_leads WHERE status = 'new'");
  res.render("articles", {
    title: "News", list, kind, status, q, source, category, per, page, from, to, dateField, sort: sortKey, matched, totals, byKind, categories, sources: sources.map((s) => s.name),
    leads: leads.n, KINDS, cars: await carOptions(), articlePath, scrapeCategories: SCRAPE_CATEGORIES, ai: aiStatus().some((p) => p.configured),
  });
});

// The "Run scraper" button. Streams one log line per step as plain text; closing the window stops it.
articlesRouter.post("/scrape", async (req, res) => {
  const b = { ...req.query, ...req.body };
  res.status(200);
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store, no-transform");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();
  let stopped = false;
  res.on("close", () => {
    if (!res.writableFinished) stopped = true;
  });
  const log = (line) => {
    if (res.writableEnded || stopped) return;
    res.write(`${line}\n`);
    res.flush?.();
  };
  try {
    await runNewsScrape({ category: SCRAPE_CATEGORIES[b.category] !== undefined ? String(b.category) : "", hours: b.hours, limit: b.limit, publish: false, log, stopped: () => stopped });
    await audit(req, "scrape", "articles", null, `news scraper run from the CMS`);
  } catch (err) {
    log(`ERROR  ${err.message}`);
  }
  res.end();
});

const ids = (v) => [...new Set([].concat(v ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

async function removeArticles(req, list) {
  for (const a of list) {
    await query("DELETE FROM articles WHERE id = $1", [a.id]);
    if (a.status === "published") await addRedirect(articlePath(a), a.kind === "news" ? "/news" : a.kind === "review" ? "/expert-reviews" : "/tips-advice", { onlyIfMissing: true });
    await audit(req, "delete", "articles", a.id, a.title);
  }
  if (list.length) await contentChanged();
}

articlesRouter.post("/bulk", async (req, res) => {
  const selected = ids(req.body.ids);
  const action = ["publish", "draft", "delete"].includes(req.body.action) ? req.body.action : "";
  if (!selected.length || !action) {
    req.session.flash = { type: "err", text: "Select at least one article first." };
    return res.redirect(req.get("referer") || "/admin/articles");
  }
  const list = await rows("SELECT id, kind, slug, title, status FROM articles WHERE id = ANY($1)", [selected]);
  if (action === "delete") await removeArticles(req, list);
  else {
    await query("UPDATE articles SET status = $2, updated_at = now() WHERE id = ANY($1)", [selected, action === "publish" ? "published" : "draft"]);
    await audit(req, action === "publish" ? "publish" : "unpublish", "articles", null, `${list.length} articles`);
    await contentChanged();
  }
  req.session.flash = { type: "ok", text: action === "delete" ? `${list.length} deleted.` : `${list.length} ${action === "publish" ? "published" : "moved back to pending"}.` };
  res.redirect(req.get("referer") || "/admin/articles");
});

// Delete by date: "preview" only counts; the real call needs confirm=1.
articlesRouter.post("/delete-by-date", async (req, res) => {
  const field = DATE_FIELDS[req.body.dateField] ? req.body.dateField : "created_at";
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ""));
  if (!isDate(req.body.from) || !isDate(req.body.to) || req.body.from > req.body.to) return res.status(400).json({ error: "Choose a valid From and To date." });
  const params = [req.body.from, req.body.to];
  let extra = "";
  if (req.body.scope !== "all") extra = " AND a.status = 'draft'";
  if (req.body.kind && KINDS[req.body.kind]) extra += ` AND a.kind = $${params.push(req.body.kind)}`;
  const list = await rows(`SELECT a.id, a.kind, a.slug, a.title, a.status FROM articles a WHERE ${DATE_FIELDS[field]}::date BETWEEN $1 AND $2${extra}`, params);
  if (req.body.confirm !== "1") return res.json({ count: list.length, published: list.filter((a) => a.status === "published").length });
  await removeArticles(req, list);
  res.json({ deleted: list.length });
});


// Replace or remove the article's own picture: an uploaded file, or a link to an image.
const pictureUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)) });
articlesRouter.post("/:id/image", pictureUpload.single("file"), async (req, res) => {
  const a = await one("SELECT id, title, source FROM articles WHERE id = $1", [req.params.id]);
  const back = `/admin/articles/${req.params.id}`;
  if (!a) return res.redirect("/admin/articles");
  try {
    const credit = String(req.body.credit ?? "").trim() || a.source?.name || "";
    let saved;
    if (req.file) saved = await saveImage(req.file, { alt: a.title, credit });
    else if (String(req.body.url ?? "").trim()) {
      const why = [];
      const got = await storeStoryImage({ candidates: [String(req.body.url).trim()], title: a.title, credit, why });
      if (!got) throw new Error(`That image could not be used: ${why[0] ?? "link not reachable"}.`);
      saved = { url: got.src, w: got.w, h: got.h };
    } else throw new Error("Choose a JPG, PNG or WebP file, or paste an image link.");
    await query("UPDATE articles SET image_src = $2, image_w = $3, image_h = $4, image_alt = CASE WHEN image_alt = '' THEN $5 ELSE image_alt END, image_credit = $6, updated_at = now() WHERE id = $1", [a.id, saved.url, saved.w, saved.h, a.title, credit]);
    await audit(req, "image", "articles", a.id, a.title);
    await contentChanged();
    req.session.flash = { type: "ok", text: "Picture replaced." };
  } catch (err) {
    req.session.flash = { type: "err", text: err.message };
  }
  res.redirect(back);
});

articlesRouter.post("/:id/image/remove", async (req, res) => {
  await query("UPDATE articles SET image_src = NULL, image_w = NULL, image_h = NULL, updated_at = now() WHERE id = $1", [req.params.id]);
  await audit(req, "image-remove", "articles", req.params.id, "");
  await contentChanged();
  req.session.flash = { type: "ok", text: "Picture removed. The article shows its car's photo again." };
  res.redirect(`/admin/articles/${req.params.id}`);
});

articlesRouter.post("/:id/status", async (req, res) => {
  const a = await one("SELECT id, title, status FROM articles WHERE id = $1", [req.params.id]);
  if (a) {
    const next = a.status === "published" ? "draft" : "published";
    await query("UPDATE articles SET status = $2, updated_at = now() WHERE id = $1", [a.id, next]);
    await audit(req, next === "published" ? "publish" : "unpublish", "articles", a.id, a.title);
    await contentChanged();
    req.session.flash = { type: "ok", text: next === "published" ? `Published "${a.title}".` : `Moved "${a.title}" back to draft. It is off the website.` };
  }
  res.redirect(req.get("referer") || "/admin/articles");
});


articlesRouter.post("/ai", async (req, res) => {
  const kind = req.body.kind;
  try {
    let id;
    if (kind === "review") {
      if (!req.body.car_id) throw new Error("Choose the car to review.");
      id = await draftReview(req, Number(req.body.car_id));
    } else {
      const topic = String(req.body.topic ?? "").trim();
      const primary = String(req.body.primary ?? "").trim().toLowerCase();
      if (topic.length < 8 || !primary) throw new Error("Describe the topic in a sentence and give the main keyword.");
      id = await draftAdvice(req, { topic, primary, secondary: String(req.body.secondary ?? "").split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean) });
    }
    req.session.flash = { type: "ok", text: "AI wrote a draft. Read it, fix anything, then set Status to Published and Save." };
    res.redirect(`/admin/articles/${id}`);
  } catch (err) {
    req.session.flash = { type: "err", text: err.message };
    res.redirect("/admin/articles");
  }
});

articlesRouter.get("/new", async (req, res) => {
  const a = { id: null, kind: KINDS[req.query.kind] ? req.query.kind : "news", slug: "", title: "", excerpt: "", category: "news", author: DESK, author_id: null, published_on: new Date().toISOString().slice(0, 10), minutes: 5, car_id: null, rival_id: null, photo_car_id: null, body: [], body_html: "", keywords: [], tags: [], seo: {}, source: null, status: "draft", is_featured: false, is_breaking: false, no_index: false, canonical_url: "", image_alt: "", image_title: "", image_credit: "", cover_alt: "", cover_title: "" };
  res.render("article-edit", { title: "New article", a, isNew: true, authors: await authorList(), categories: await categoryList("news"), html: "", cars: await carOptions(), KINDS, text: { faqs: "" }, seo: checkSeo({ title: "", description: "", h1: "", sections: [] }), path: "" });
});

articlesRouter.get("/:id", async (req, res, next) => {
  const a = await one("SELECT * FROM articles WHERE id = $1", [req.params.id]);
  if (!a) return next();
  const seo = checkSeo({ title: a.seo?.title || a.title, description: a.seo?.description || a.excerpt, h1: a.title, sections: a.body, primary: a.keywords?.[0], secondary: a.keywords?.slice(1), minWords: a.kind === "news" ? 300 : 500 });
  res.render("article-edit", { title: a.title, a, isNew: false, authors: await authorList(), categories: await categoryList(a.category), html: a.body_html ?? sectionsToHtml(a.body), cars: await carOptions(), KINDS, text: { faqs: faqsToText(a.seo?.faqs) }, seo, path: articlePath(a) });
});

articlesRouter.get("/:id/view", async (req, res, next) => {
  const a = await one("SELECT * FROM articles WHERE id = $1", [req.params.id]);
  if (!a) return next();
  const seo = checkSeo({ title: a.seo?.title || a.title, description: a.seo?.description || a.excerpt, h1: a.title, sections: a.body, primary: a.keywords?.[0], secondary: a.keywords?.slice(1), minWords: a.kind === "news" ? 300 : 500 });
  const photo = (await one("SELECT src FROM photos WHERE car_id = COALESCE($1::int, $2::int) ORDER BY sort, id LIMIT 1", [a.photo_car_id, a.car_id]))?.src;
  res.render("article-view", { title: `Preview: ${a.title}`, a, seo, KINDS, path: articlePath(a), photo: a.cover_src || a.image_src || (photo ? (/^https?:/.test(photo) || photo.startsWith("/uploads") ? photo : `${config.siteUrl}${photo}`) : "") });
});

const intOrNull = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const str = (v, n) => String(v ?? "").trim().slice(0, n);
const tagsFrom = (t) => [...new Set(String(t ?? "").split(",").map((x) => x.trim().toLowerCase().replace(/\s+/g, " ")).filter((x) => x && x.length <= 40))].slice(0, 20);

function readForm(b) {
  const html = cleanHtml(b.body_html);
  const sections = htmlToSections(html);
  const typed = Number(b.minutes);
  return {
    kind: KINDS[b.kind] ? b.kind : "news",
    title: str(b.title, 300),
    slug: slugify(b.slug || b.title),
    excerpt: str(b.excerpt, 600),
    category: str(b.category, 40).toLowerCase() || "news",
    author_id: intOrNull(b.author_id),
    author: DESK, // replaced by the chosen author's name in save()
    published_on: b.published_on || new Date().toISOString().slice(0, 10),
    minutes: typed > 0 ? Math.round(typed) : Math.max(1, Math.round(countWords(sections) / 200)) || 5,
    car_id: intOrNull(b.car_id),
    rival_id: intOrNull(b.rival_id),
    photo_car_id: intOrNull(b.photo_car_id) ?? intOrNull(b.car_id),
    body: sections,
    body_html: html || null,
    keywords: String(b.keywords ?? "").split(/\r?\n/).map((x) => x.trim().toLowerCase()).filter(Boolean),
    tags: tagsFrom(b.tags),
    seo: { title: str(b.seo_title, 120), description: str(b.seo_description, 320), faqs: faqsFromText(b.faqs) },
    source: b.source_url?.trim() ? { name: str(b.source_name, 120) || new URL(b.source_url.trim()).hostname, url: b.source_url.trim() } : null,
    status: b.status === "published" ? "published" : "draft",
    image_src: str(b.image_src, 600) || null,
    image_w: intOrNull(b.image_w),
    image_h: intOrNull(b.image_h),
    image_alt: str(b.image_alt, 200),
    image_title: str(b.image_title, 200),
    image_credit: str(b.image_credit, 120),
    cover_src: str(b.cover_src, 600) || null,
    cover_w: intOrNull(b.cover_w),
    cover_h: intOrNull(b.cover_h),
    cover_alt: str(b.cover_alt, 200),
    cover_title: str(b.cover_title, 200),
    og_src: str(b.og_src, 600) || null,
    canonical_url: str(b.canonical_url, 400),
    no_index: b.no_index === "on",
    is_featured: b.is_featured === "on",
    is_breaking: b.is_breaking === "on",
  };
}

/** A picture linked by address is checked and saved on our own server; one we already hold is kept as it is. */
async function resolvePictures(v) {
  for (const p of ["image", "cover", "og"]) {
    const src = v[`${p}_src`];
    if (!src || isOwnUpload(src) || src.startsWith("/uploads")) continue;
    const why = [];
    const got = await storeStoryImage({ candidates: [src], title: v.title, credit: v.image_credit, why });
    if (!got) throw new Error(`The ${p === "image" ? "listing image" : p === "cover" ? "detail banner" : "social image"} link could not be used: ${why[0] ?? "it did not load"}.`);
    v[`${p}_src`] = got.src;
    if (p !== "og") {
      v[`${p}_w`] = got.w;
      v[`${p}_h`] = got.h;
    }
  }
}

async function save(req, res, id) {
  let v;
  try {
    v = readForm(req.body);
  } catch {
    req.session.flash = { type: "err", text: "The source link is not a valid URL." };
    return res.redirect(id ? `/admin/articles/${id}` : "/admin/articles/new");
  }
  try {
    v.author = v.author_id ? ((await one("SELECT name FROM authors WHERE id = $1", [v.author_id]))?.name ?? DESK) : DESK;
    await resolvePictures(v);
    const car = v.car_id ? await one("SELECT b.name || ' ' || c.name AS n FROM cars c JOIN brands b ON b.id = c.brand_id WHERE c.id = $1", [v.car_id]) : null;
    fillArticle(v, { carName: car?.n ?? "" }); // nothing has to be typed by hand: blanks are filled in
  } catch (err) {
    req.session.flash = { type: "err", text: err.message };
    return res.redirect(id ? `/admin/articles/${id}` : "/admin/articles/new");
  }
  if (!v.title) {
    req.session.flash = { type: "err", text: "Title is required." };
    return res.redirect(id ? `/admin/articles/${id}` : "/admin/articles/new");
  }
  if (v.kind === "news" && v.status === "published" && !v.body.length && !v.car_id) {
    req.session.flash = { type: "err", text: "A news story needs a body (or a car, so the website can build one from its data)." };
    return res.redirect(id ? `/admin/articles/${id}` : "/admin/articles/new");
  }
  try {
    const before = id ? await one("SELECT kind, slug, status, seo FROM articles WHERE id = $1", [id]) : null;
    // Keep what the AI recorded (which model wrote it) when an editor saves.
    if (before?.seo) v.seo = { ...before.seo, ...v.seo, score: undefined };
    const cols = Object.keys(v);
    const vals = cols.map((c) => (["body", "keywords", "seo", "source"].includes(c) ? JSON.stringify(v[c]) : v[c]));
    let row;
    if (id) row = await one(`UPDATE articles SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 RETURNING id`, [id, ...vals]);
    else row = await one(`INSERT INTO articles (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, vals);
    if (before && before.status === "published" && (before.slug !== v.slug || before.kind !== v.kind)) {
      await addRedirect(articlePath(before), articlePath(v));
    }
    await audit(req, id ? "update" : "create", "articles", row.id, v.title);
    await contentChanged();
    req.session.flash = { type: "ok", text: v.status === "published" ? "Saved and published. The website updates in a few seconds." : "Saved as a draft (not on the website yet)." };
    res.redirect(`/admin/articles/${row.id}`);
  } catch (err) {
    req.session.flash = { type: "err", text: friendly(err) };
    res.redirect(id ? `/admin/articles/${id}` : "/admin/articles/new");
  }
}

articlesRouter.post("/new", (req, res) => save(req, res, null));
articlesRouter.post("/:id", (req, res) => save(req, res, Number(req.params.id)));

articlesRouter.post("/:id/delete", async (req, res) => {
  const a = await one("SELECT * FROM articles WHERE id = $1", [req.params.id]);
  if (a) {
    await query("DELETE FROM articles WHERE id = $1", [a.id]);
    if (a.status === "published") await addRedirect(articlePath(a), a.kind === "news" ? "/news" : a.kind === "review" ? "/expert-reviews" : "/tips-advice", { onlyIfMissing: true });
    await audit(req, "delete", "articles", a.id, a.title);
    await contentChanged();
    req.session.flash = { type: "ok", text: `Deleted "${a.title}".${a.status === "published" ? " Its URL now redirects to the section page." : ""}` };
  }
  res.redirect("/admin/articles");
});

articlesRouter.post("/:id/ai-seo", async (req, res) => {
  const a = await one("SELECT * FROM articles WHERE id = $1", [req.params.id]);
  try {
    const text = (a.body ?? []).map((s) => [s.h, ...(s.p ?? [])].join(" ")).join(" ") || a.excerpt;
    const meta = await writeSeoMeta({ path: articlePath(a), h1: a.title, text, primary: a.keywords?.[0] ?? "", secondary: a.keywords?.slice(1) ?? [] });
    await query("UPDATE articles SET seo = seo || $2::jsonb, updated_at = now() WHERE id = $1", [a.id, JSON.stringify({ title: meta.title, description: meta.description })]);
    await contentChanged();
    req.session.flash = { type: "ok", text: `AI (${meta.provider}) rewrote the Google title and description.` };
  } catch (err) {
    req.session.flash = { type: "err", text: err.message };
  }
  res.redirect(`/admin/articles/${req.params.id}#seo`);
});
