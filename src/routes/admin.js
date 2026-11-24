import bcrypt from "bcryptjs";
import { Router } from "express";
import { config } from "../config.js";
import { getSetting, one, query, rows, setSetting } from "../db.js";
import { DEFAULT_SOURCES } from "../importers/news.js";
import { aiStatus } from "../lib/ai.js";
import { requireAdmin } from "../lib/auth.js";
import { audit, contentChanged, lastRefresh, notifyWebsite } from "../lib/publish.js";
import { analyticsRouter } from "./analytics.js";
import { articlesRouter } from "./articles.js";
import { authorsRouter } from "./authors.js";
import { carScraperRouter } from "./carscraper.js";
import { carsRouter } from "./cars.js";
import { crudRouter } from "./crud.js";
import { mediaRouter } from "./media.js";
import { newsRouter } from "./news.js";
import { seoRouter } from "./seo.js";

export const adminRouter = Router();

adminRouter.use("/r", crudRouter);
adminRouter.use("/cars", carsRouter);
adminRouter.use("/articles", articlesRouter);
adminRouter.use("/authors", authorsRouter);
adminRouter.use("/news", newsRouter);
adminRouter.use("/seo", seoRouter);
adminRouter.use("/media", mediaRouter);
adminRouter.use("/analytics", analyticsRouter);
// The old Scraper section and the free-data imports are switched off: all car data comes from CarScrapper.
adminRouter.use(["/scraper", "/imports"], (req, res) => res.redirect("/admin/carscraper"));
adminRouter.use("/carscraper", carScraperRouter);

const count = async (sql, params = []) => (await one(sql, params)).n;

adminRouter.get("/", async (req, res) => {
  const stats = {
    cars: await count("SELECT count(*)::int AS n FROM cars WHERE published AND EXISTS (SELECT 1 FROM photos p WHERE p.car_id = cars.id)"),
    hidden: await count("SELECT count(*)::int AS n FROM cars WHERE NOT published OR NOT EXISTS (SELECT 1 FROM photos p WHERE p.car_id = cars.id)"),
    articles: await count("SELECT count(*)::int AS n FROM articles WHERE status = 'published'"),
    drafts: await count("SELECT count(*)::int AS n FROM articles WHERE status = 'draft'"),
    leads: await count("SELECT count(*)::int AS n FROM news_leads WHERE status = 'new'"),
    launches: await count("SELECT count(*)::int AS n FROM news_leads WHERE status = 'new' AND is_launch"),
    pendingReviews: await count("SELECT count(*)::int AS n FROM owner_reviews WHERE status = 'pending'"),
    keywords: await count("SELECT count(*)::int AS n FROM keywords"),
    views7: await count("SELECT count(*)::int AS n FROM analytics_events WHERE type = 'pageview' AND ts > now() - interval '7 days'"),
    clicks7: await count("SELECT count(*)::int AS n FROM analytics_events WHERE type = 'click' AND ts > now() - interval '7 days'"),
    noCopy: await count("SELECT count(*)::int AS n FROM cars WHERE published AND jsonb_array_length(overview) = 0"),
  };
  const demo = {
    articles: await count("SELECT count(*)::int AS n FROM articles WHERE is_demo"),
    offers: await count("SELECT count(*)::int AS n FROM offers WHERE is_demo"),
    dealers: await count("SELECT count(*)::int AS n FROM dealers WHERE is_demo"),
    stations: await count("SELECT count(*)::int AS n FROM stations WHERE is_demo"),
    reviews: await count("SELECT count(*)::int AS n FROM owner_reviews WHERE is_demo"),
    fuel: await count("SELECT count(*)::int AS n FROM fuel_prices WHERE is_demo"),
  };
  const newModels = await rows("SELECT c.id, b.name || ' ' || c.name AS name, c.min_price FROM cars c JOIN brands b ON b.id = c.brand_id WHERE NOT c.published OR NOT EXISTS (SELECT 1 FROM photos p WHERE p.car_id = c.id) ORDER BY c.created_at DESC, c.popularity DESC LIMIT 12");
  const runs = await rows("SELECT id, kind, status, started_at FROM import_runs ORDER BY id DESC LIMIT 6");
  const recent = await rows("SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 8");
  const series = await rows("SELECT d::date AS day, COALESCE(c.n, 0)::int AS views FROM generate_series(current_date - 29, current_date, interval '1 day') d LEFT JOIN (SELECT date_trunc('day', ts)::date AS day, count(*) AS n FROM analytics_events WHERE type = 'pageview' AND ts > now() - interval '30 days' GROUP BY 1) c ON c.day = d::date ORDER BY d");
  const waiting = await count("SELECT count(*)::int AS n FROM scraper_imports WHERE status = 'awaiting_confirmation'").catch(() => 0);
  const scrape = null; // the old Scraper service is switched off (CarScrapper has its own screens)
  res.render("dashboard", { title: "Dashboard", stats, demo, newModels, runs, recent, series, waiting, scrape, ai: aiStatus(), refresh: lastRefresh() });
});

adminRouter.post("/refresh-website", async (req, res) => {
  await contentChanged();
  const r = await notifyWebsite();
  req.session.flash = { type: r.ok ? "ok" : "err", text: r.message };
  res.redirect(req.get("referer") || "/admin");
});

adminRouter.post("/demo/remove", requireAdmin, async (req, res) => {
  const what = String(req.body.what ?? "");
  const tables = { articles: "articles", offers: "offers", dealers: "dealers", stations: "stations", reviews: "owner_reviews", fuel: "fuel_prices" };
  if (!tables[what]) return res.redirect("/admin");
  const r = await query(`DELETE FROM ${tables[what]} WHERE is_demo`);
  await audit(req, "delete-demo", what, null, `${r.rowCount} rows`);
  await contentChanged();
  req.session.flash = { type: "ok", text: `Removed ${r.rowCount} demo ${what}.` };
  res.redirect("/admin");
});

adminRouter.get("/help", (req, res) => res.render("help", { title: "How to use the CMS" }));

adminRouter.get("/menus", async (req, res) => {
  res.render("menus", { title: "Menus", siteNav: await getSetting("nav", []), footer: await getSetting("footer", []), error: null });
});
adminRouter.post("/menus", async (req, res) => {
  try {
    const nav = JSON.parse(req.body.nav);
    const footer = JSON.parse(req.body.footer);
    if (!Array.isArray(nav) || !Array.isArray(footer)) throw new Error("Both menus must be lists [ ... ].");
    for (const t of nav) if (!t.label || !t.href || !Array.isArray(t.groups)) throw new Error("Every top menu item needs label, href and groups.");
    for (const g of footer) if (!g.title || !Array.isArray(g.links)) throw new Error("Every footer column needs title and links.");
    await setSetting("nav", nav);
    await setSetting("footer", footer);
    await audit(req, "update", "menus");
    await contentChanged();
    req.session.flash = { type: "ok", text: "Menus saved. The website updates in a few seconds." };
    res.redirect("/admin/menus");
  } catch (err) {
    res.status(400).render("menus", { title: "Menus", siteNav: req.body.nav, footer: req.body.footer, error: `Not saved: ${err.message}` });
  }
});

adminRouter.get("/settings", async (req, res) => {
  res.render("settings", {
    title: "Settings",
    site: await getSetting("site", {}),
    analytics: await getSetting("analytics", {}),
    autoDraft: await getSetting("auto_draft", { enabled: true, perRun: 5, publish: false }),
    autoCars: await getSetting("auto_cars", { enabled: true, photoCars: 15, aiOverviews: 3, confirmUpdates: true }),
    sources: await getSetting("news_sources", DEFAULT_SOURCES),
    scheduler: await getSetting("scheduler", {}),
    ai: aiStatus(),
    config: { siteUrl: config.siteUrl, schedulerEnabled: config.schedulerEnabled, revalidate: Boolean(config.revalidateSecret), ocm: Boolean(config.openChargeMapKey) },
    error: null,
  });
});
adminRouter.post("/settings", async (req, res) => {
  const b = req.body;
  try {
    const sources = JSON.parse(b.sources || "[]");
    if (!Array.isArray(sources)) throw new Error("News sources must be a list.");
    await setSetting("site", { name: b.name.trim(), tagline: b.tagline.trim(), phone: b.phone.trim(), email: b.email.trim() });
    await setSetting("analytics", { ga4Id: b.ga4Id.trim(), clarityId: b.clarityId.trim(), gscVerification: b.gscVerification.trim(), bingVerification: b.bingVerification.trim(), firstParty: b.firstParty === "on" });
    await setSetting("auto_cars", { enabled: b.autoCars === "on", photoCars: Math.min(60, Math.max(0, Number(b.carPhotos) || 0)), aiOverviews: Math.min(25, Math.max(0, Number(b.carGuides) || 0)), confirmUpdates: b.carConfirm === "on" });
    await setSetting("auto_draft", { enabled: b.autoDraft === "on", perRun: Math.min(25, Math.max(1, Number(b.perRun) || 5)), publish: b.autoPublish === "on" });
    await setSetting("news_sources", sources);
    await audit(req, "update", "settings");
    await contentChanged();
    req.session.flash = { type: "ok", text: "Settings saved." };
  } catch (err) {
    req.session.flash = { type: "err", text: `Not saved: ${err.message}` };
  }
  res.redirect("/admin/settings");
});

adminRouter.get("/activity", async (req, res) => {
  const list = await rows("SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 200");
  res.render("activity", { title: "Activity log", list });
});

adminRouter.get("/account", (req, res) => res.render("account", { title: "My account", error: null }));
adminRouter.post("/account", async (req, res) => {
  const user = await one("SELECT * FROM users WHERE id = $1", [req.session.user.id]);
  const { current, next, confirm } = req.body;
  let error = null;
  if (!(await bcrypt.compare(String(current ?? ""), user.password_hash))) error = "Current password is wrong.";
  else if (String(next ?? "").length < 10) error = "New password must be at least 10 characters.";
  else if (next !== confirm) error = "The two new passwords do not match.";
  if (error) return res.status(400).render("account", { title: "My account", error });
  await query("UPDATE users SET password_hash = $2 WHERE id = $1", [user.id, await bcrypt.hash(next, 12)]);
  await audit(req, "password", "users", user.id);
  req.session.flash = { type: "ok", text: "Password changed." };
  res.redirect("/admin/account");
});

adminRouter.get("/users", requireAdmin, async (req, res) => {
  res.render("users", { title: "Users", list: await rows("SELECT id, email, name, role, last_login, created_at FROM users ORDER BY id"), error: null });
});
adminRouter.post("/users", requireAdmin, async (req, res) => {
  const email = String(req.body.email ?? "").trim().toLowerCase();
  const password = String(req.body.password ?? "");
  const role = req.body.role === "admin" ? "admin" : "editor";
  if (!email.includes("@") || password.length < 10 || !req.body.name?.trim()) {
    return res.status(400).render("users", { title: "Users", list: await rows("SELECT id, email, name, role, last_login, created_at FROM users ORDER BY id"), error: "Enter a name, a valid email and a password of at least 10 characters." });
  }
  try {
    await query("INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4)", [email, req.body.name.trim(), await bcrypt.hash(password, 12), role]);
    await audit(req, "create", "users", email);
    req.session.flash = { type: "ok", text: `Added ${email}. Share the password with them privately.` };
  } catch {
    req.session.flash = { type: "err", text: "A user with this email already exists." };
  }
  res.redirect("/admin/users");
});
adminRouter.post("/users/:id/delete", requireAdmin, async (req, res) => {
  if (Number(req.params.id) === req.session.user.id) {
    req.session.flash = { type: "err", text: "You cannot remove your own account." };
  } else {
    await query("DELETE FROM users WHERE id = $1", [req.params.id]);
    await audit(req, "delete", "users", req.params.id);
    req.session.flash = { type: "ok", text: "User removed." };
  }
  res.redirect("/admin/users");
});
