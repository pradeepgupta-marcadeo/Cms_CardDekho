import { Router } from "express";
import { one, query, rows } from "../db.js";
import { runNews } from "../importers/news.js";
import { draftFromLead } from "../lib/drafts.js";
import { startRun } from "../lib/runs.js";

export const newsRouter = Router();

newsRouter.get("/", async (req, res) => {
  const status = ["new", "drafted", "ignored"].includes(req.query.status) ? req.query.status : "new";
  const launchOnly = req.query.launch === "1";
  const list = await rows(
    `SELECT l.*, b.name || ' ' || c.name AS car FROM news_leads l LEFT JOIN cars c ON c.id = l.car_id LEFT JOIN brands b ON b.id = c.brand_id
     WHERE l.status = $1 ${launchOnly ? "AND l.is_launch" : ""} ORDER BY l.published_at DESC NULLS LAST, l.id DESC LIMIT 150`,
    [status],
  );
  const lastRun = await one("SELECT * FROM import_runs WHERE kind = 'news' ORDER BY id DESC LIMIT 1");
  const counts = await one("SELECT count(*) FILTER (WHERE status = 'new')::int AS new, count(*) FILTER (WHERE status = 'drafted')::int AS drafted, count(*) FILTER (WHERE status = 'ignored')::int AS ignored FROM news_leads");
  res.render("news", { title: "News inbox", list, status, launchOnly, lastRun, counts });
});

newsRouter.post("/fetch", async (req, res) => {
  const id = await startRun("news", (log) => runNews({ log }));
  req.session.flash = { type: "info", text: "Fetching news from all sources. This takes about a minute; refresh this page to see new leads." };
  res.redirect(`/admin/imports/runs/${id}`);
});

newsRouter.post("/:id/draft", async (req, res) => {
  try {
    const articleId = await draftFromLead(req, Number(req.params.id));
    req.session.flash = { type: "ok", text: "AI wrote an original draft from this report. Check the facts against the source, then publish." };
    res.redirect(`/admin/articles/${articleId}`);
  } catch (err) {
    req.session.flash = { type: "err", text: `AI draft failed: ${err.message}` };
    res.redirect("/admin/news");
  }
});

newsRouter.post("/:id/status", async (req, res) => {
  const s = ["new", "ignored"].includes(req.body.status) ? req.body.status : "ignored";
  await query("UPDATE news_leads SET status = $2 WHERE id = $1", [req.params.id, s]);
  res.redirect(req.get("referer") || "/admin/news");
});

newsRouter.post("/ignore-old", async (req, res) => {
  const r = await query("UPDATE news_leads SET status = 'ignored' WHERE status = 'new' AND COALESCE(published_at, created_at) < now() - interval '4 days'");
  req.session.flash = { type: "ok", text: `Ignored ${r.rowCount} leads older than 4 days.` };
  res.redirect("/admin/news");
});
