// Endpoints the website calls. No login: they only read published content or
// accept small, validated submissions.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import { config } from "../config.js";
import { one, query } from "../db.js";
import { buildSnapshot } from "../lib/snapshot.js";

export const publicRouter = Router();

publicRouter.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && config.corsOrigins.includes(origin)) {
    res.set("access-control-allow-origin", origin);
    res.set("vary", "Origin");
    res.set("access-control-allow-headers", "content-type");
    res.set("access-control-allow-methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
publicRouter.use(express.json({ limit: "16kb" }));
publicRouter.use(express.text({ limit: "16kb", type: "text/plain" }));

publicRouter.get("/snapshot", async (req, res) => {
  const snap = await buildSnapshot();
  const etag = `"${snap.version}"`;
  res.set("etag", etag);
  res.set("cache-control", "no-cache");
  if (req.get("if-none-match") === etag) return res.sendStatus(304);
  res.json(snap);
});

// Read by the website proxy once a minute, so only the small redirect list travels.
// Every Indian city the site's city picker can search: name, state and slug (CarScrapper's city_catalog.json,
// refreshed weekly by scrape.py). The website marks the ones it has exact on-road prices for.
let cityList = { mtime: 0, body: "[]" };
publicRouter.get("/cities", (req, res) => {
  const file = path.join(path.dirname(config.carScraper.script), "cardekho_data", "city_catalog.json");
  try {
    const mtime = existsSync(file) ? statSync(file).mtimeMs : 0;
    if (mtime && mtime !== cityList.mtime) {
      const list = JSON.parse(readFileSync(file, "utf8"))
        .filter((c) => c.name && c.state)
        .map((c) => ({ n: c.name, s: c.state, g: c.slug }))
        .sort((a, b) => a.n.localeCompare(b.n));
      cityList = { mtime, body: JSON.stringify(list) };
    }
  } catch {
    // keep the last good list
  }
  res.set("cache-control", "public, max-age=3600");
  res.type("json").send(cityList.body);
});

publicRouter.get("/redirects", async (req, res) => {
  const snap = await buildSnapshot();
  res.set("cache-control", "public, max-age=30");
  res.json(snap.redirects);
});

// Every live variant page, so the website proxy can 301 retired variant URLs on the first request.
publicRouter.get("/variant-paths", async (req, res) => {
  const snap = await buildSnapshot();
  res.set("cache-control", "public, max-age=30");
  // Only cars with real variants; for the rest the website shows an indicative list of its own.
  res.json(Object.fromEntries(snap.cars.filter((c) => c.variants.length).map((c) => [`/cars/${c.brandSlug}/${c.slug}`, c.variants.map((v) => v.slug)])));
});

publicRouter.get("/version", async (req, res) => {
  const snap = await buildSnapshot();
  res.json({ version: snap.version, generatedAt: snap.generatedAt });
});

// Small per-IP budget so the beacon and review form cannot be flooded.
const hits = new Map();
function allow(ip, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) return false;
  list.push(now);
  hits.set(ip, list);
  return true;
}
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|monitor/i;

// Cookie-free analytics: the visitor ID is a daily hash of IP + browser, so no one can be tracked across days.
publicRouter.post("/collect", async (req, res) => {
  res.sendStatus(204);
  try {
    const ua = req.get("user-agent") ?? "";
    if (BOT.test(ua) || !allow(req.ip, 120, 60000)) return;
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
    const type = body.type === "click" ? "click" : "pageview";
    const path = String(body.path ?? "").slice(0, 300);
    if (!path.startsWith("/")) return;
    const target = body.target ? String(body.target).slice(0, 120) : null;
    let referrer = "";
    try {
      const r = body.referrer ? new URL(String(body.referrer)) : null;
      if (r && !config.corsOrigins.some((o) => o.includes(r.host))) referrer = r.host.replace(/^www\./, "");
    } catch {
      referrer = "";
    }
    const device = /mobile|android|iphone/i.test(ua) ? "mobile" : /ipad|tablet/i.test(ua) ? "tablet" : "desktop";
    const visitor = createHash("sha256").update(`${new Date().toISOString().slice(0, 10)}|${req.ip}|${ua}|${config.sessionSecret}`).digest("hex").slice(0, 16);
    await query("INSERT INTO analytics_events (type, path, target, referrer, device, visitor) VALUES ($1,$2,$3,$4,$5,$6)", [type, path, target, referrer, device, visitor]);
  } catch {
    // Analytics must never break the website.
  }
});

publicRouter.post("/reviews", async (req, res) => {
  if (!allow(`r:${req.ip}`, 5, 3600000)) return res.status(429).json({ error: "Too many reviews from this connection. Try again later." });
  const b = req.body ?? {};
  if (b.website) return res.json({ ok: true }); // honeypot field, filled only by bots
  const car = String(b.car ?? "");
  const rating = Number(b.rating);
  const author = String(b.author ?? "").trim().slice(0, 60);
  const title = String(b.title ?? "").trim().slice(0, 120);
  const text = String(b.text ?? "").trim().slice(0, 3000);
  if (!car || !(rating >= 1 && rating <= 5) || author.length < 2 || title.length < 4 || text.split(/\s+/).length < 20) {
    return res.status(400).json({ error: "Please choose the car, a rating, your name, a title and at least 20 words." });
  }
  const row = await one("SELECT c.id FROM cars c JOIN brands b ON b.id = c.brand_id WHERE b.slug || '-' || c.slug = $1 OR (b.name || ' ' || c.name) = $1", [car]);
  if (!row) return res.status(400).json({ error: "Unknown car." });
  await query("INSERT INTO owner_reviews (car_id, author, rating, title, text, status) VALUES ($1,$2,$3,$4,$5,'pending')", [row.id, author, Math.round(rating), title, text]);
  res.json({ ok: true, message: "Thank you. Your review will appear after our team checks it." });
});
