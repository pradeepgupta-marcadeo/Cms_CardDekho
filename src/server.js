import { mkdirSync } from "node:fs";
import { buildNav } from "./lib/nav.js";
import path from "node:path";
import compression from "compression";
import connectPg from "connect-pg-simple";
import express from "express";
import session from "express-session";
import helmet from "helmet";
import { ROOT, assertConfig, config } from "./config.js";
import { pool } from "./db.js";
import { csrfToken, requireLogin, verifyCsrf } from "./lib/auth.js";
import { startScheduler } from "./jobs/scheduler.js";
import { backfillArticles } from "./lib/autofill.js";
import { startCarScraper } from "./lib/carscraper.js";
import { usesCloud } from "./lib/storage.js";
import { adminRouter } from "./routes/admin.js";
import { authRouter } from "./routes/auth.js";
import { publicRouter } from "./routes/public.js";

assertConfig();
// On Vercel (no disk) images live in Supabase Storage, so there is no uploads folder to make.
const ON_VERCEL = Boolean(process.env.VERCEL);
if (!usesCloud && !ON_VERCEL) mkdirSync(config.uploadDir, { recursive: true });

const app = express();
// Behind Vercel's proxy the visitor's https comes through one hop (needed for the secure login cookie).
app.set("trust proxy", ON_VERCEL ? 1 : "loopback");
app.set("view engine", "ejs");
app.set("views", path.join(ROOT, "src", "views"));
app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        // The scraper service serves thumbnails of licensed photos for review.
        "img-src": ["'self'", "data:", "https:", "http://localhost:3000", "http://localhost:3001", config.scraper.url],
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        // A few screens set widths with style="" attributes.
        "style-src-attr": ["'unsafe-inline'"],
        "connect-src": ["'self'"],
        "frame-src": ["https://sketchfab.com"],
        "form-action": ["'self'"],
        "upgrade-insecure-requests": null,
      },
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
app.use(compression());

// Public API and uploaded files: no session needed.
app.use("/uploads", express.static(config.uploadDir, { maxAge: "365d", immutable: true }));
app.use("/api/public", publicRouter);

app.use("/static", express.static(path.join(ROOT, "src", "public"), { maxAge: config.production ? "7d" : 0 }));
// The SEO checker runs in the browser too, so the editor shows the same score the server does.
// The rich-text editor (CKEditor 5, GPL build) is served from the installed package, so no outside script is needed.
app.use("/static/vendor/ckeditor5", express.static(path.join(ROOT, "node_modules", "ckeditor5", "dist", "browser"), { maxAge: config.production ? "7d" : 0, index: false }));
app.use("/static/lib", express.static(path.join(ROOT, "src", "lib"), { maxAge: 0, index: false, extensions: ["js"], setHeaders: (res) => res.type("text/javascript") }));

const PgStore = connectPg(session);
app.use(
  session({
    store: new PgStore({ pool, tableName: "session" }),
    name: "wl_cms",
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: config.production, maxAge: 7 * 24 * 3600 * 1000 },
  }),
);
app.use(express.urlencoded({ extended: true, limit: "4mb" }));
app.use(express.json({ limit: "4mb" }));
app.use((req, res, next) => {
  res.locals.user = req.session?.user ?? null;
  res.locals.csrf = req.session ? csrfToken(req) : "";
  res.locals.path = req.path;
  res.locals.nav = buildNav(req.path, req.session?.user);
  res.locals.siteUrl = config.siteUrl;
  res.locals.flash = req.session?.flash ?? null;
  if (req.session) delete req.session.flash;
  next();
});
app.use(verifyCsrf);

app.get("/", (req, res) => res.redirect("/admin"));
app.use("/admin", authRouter);
app.use("/admin", requireLogin, adminRouter);

app.use((req, res) => res.status(404).render("error", { title: "Page not found", message: "This CMS page does not exist." }));
app.use((err, req, res, _next) => {
  console.error(err);
  if (req.accepts(["html", "json"]) === "json") return res.status(500).json({ error: err.message });
  res.status(500).render("error", { title: "Something went wrong", message: err.message });
});

// On Vercel the app is a serverless function (api/index.mjs): no server of its own, no background jobs
// (scraping and schedules run from the CMS on your own computer).
export default app;

if (!ON_VERCEL) app.listen(config.port, () => {
  console.log(`Wheelora CMS running at ${config.cmsUrl}/admin`);
  if (config.schedulerEnabled) startScheduler();
  // CarScrapper tab: close runs cut off by a restart; run its schedules only when the scheduler is on.
  startCarScraper({ schedule: config.schedulerEnabled }).catch((err) => console.error("CarScrapper:", err.message));
  // Older articles get their banner, alt text, tags and SEO fields filled in too.
  backfillArticles().then((n) => n && console.log(`Filled the blank fields of ${n} article(s).`), (e) => console.error("Backfill failed:", e.message));
});
