// "Scraper" section of the CMS: review what the automotive scraper collected,
// manage its sources and jobs, and import approved records into the catalogue.
import { Router } from "express";
import { one, rows } from "../db.js";
import { audit } from "../lib/publish.js";
import { ScraperUnavailable, scraper } from "../lib/scraper-client.js";
import { importRecord, mapModel, planImport } from "../lib/scraper-import.js";

export const scraperRouter = Router();

const PAGE = 50;
const back = (req, fallback) => req.get("referer") || fallback;
const flash = (req, type, text) => {
  req.session.flash = { type, text };
};

// Every screen shows a clear message instead of crashing when the service is down.
const safe = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    if (err instanceof ScraperUnavailable) return res.status(503).render("scraper-offline", { title: "Scraper", message: err.message });
    next(err);
  }
};

/** CMS cars matching scraper records, keyed by "brand/slug". */
async function cmsMatches(keys) {
  if (!keys.length) return new Map();
  const list = await rows("SELECT c.id, c.name, c.published, b.slug || '/' || c.slug AS key, c.source->>'scraperModelId' AS sid FROM cars c JOIN brands b ON b.id = c.brand_id WHERE b.slug || '/' || c.slug = ANY($1)", [keys]);
  return new Map(list.map((c) => [c.key, c]));
}

scraperRouter.get(
  "/",
  safe(async (req, res) => {
    const d = await scraper("/dashboard");
    const imports = await rows("SELECT * FROM scraper_imports ORDER BY id DESC LIMIT 10");
    const counts = await one("SELECT count(*) FILTER (WHERE status = 'done')::int AS done, count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status = 'awaiting_confirmation')::int AS waiting FROM scraper_imports");
    res.render("scraper-overview", { title: "Scraper overview", d, imports, counts });
  }),
);

// ---- Scraped cars ----
scraperRouter.get(
  "/cars",
  safe(async (req, res) => {
    const status = ["pending", "approved", "imported", "rejected"].includes(req.query.status) ? req.query.status : "";
    const page = Math.max(1, Number(req.query.page) || 1);
    const q = String(req.query.q ?? "").trim();
    const params = new URLSearchParams({ entityType: "model", page: String(page), limit: String(PAGE), ...(status ? { status } : {}), ...(q ? { q } : {}), ...(req.query.missing ? { missing: "true" } : {}), ...(req.query.duplicates ? { duplicates: "true" } : {}) });
    const data = await scraper(`/records?${params}`);
    const matches = await cmsMatches([...new Set(data.items.map((r) => r.parentKey).filter(Boolean))]);
    res.render("scraper-cars", { title: "Scraped cars", data, matches, status, q, page, pages: Math.ceil(data.total / PAGE), query: req.query });
  }),
);

scraperRouter.get(
  "/cars/:id",
  safe(async (req, res) => {
    const record = await scraper(`/records/${req.params.id}`);
    const p = record.payload;
    const imageRecords = record.parentKey ? (await scraper(`/records?${new URLSearchParams({ entityType: "image", parentKey: record.parentKey, limit: "60" })}`)).items : [];
    const matches = await cmsMatches(record.parentKey ? [record.parentKey] : []);
    let plan = null;
    let bundle = null;
    let planError = null;
    if (["approved", "imported"].includes(record.status) && record.entityType === "model") {
      try {
        plan = await planImport(record.id);
        bundle = plan.entity;
      } catch (err) {
        planError = err.message;
      }
    }
    const waiting = await one("SELECT * FROM scraper_imports WHERE record_id = $1 AND status = 'awaiting_confirmation' ORDER BY id DESC LIMIT 1", [record.id]);
    const history = await rows("SELECT * FROM scraper_imports WHERE record_id = $1 ORDER BY id DESC LIMIT 10", [record.id]);
    res.render("scraper-car", { title: record.title, record, p, imageRecords, cms: matches.get(record.parentKey) ?? null, plan, bundle, mapped: bundle ? mapModel(bundle) : null, planError, waiting, history });
  }),
);

// ---- Images, news and brands ----
scraperRouter.get(
  "/records",
  safe(async (req, res) => {
    const entityType = ["image", "news", "brand"].includes(req.query.entityType) ? req.query.entityType : "image";
    const status = ["pending", "approved", "imported", "rejected"].includes(req.query.status) ? req.query.status : "pending";
    const page = Math.max(1, Number(req.query.page) || 1);
    const q = String(req.query.q ?? "").trim();
    const data = await scraper(`/records?${new URLSearchParams({ entityType, status, page: String(page), limit: String(PAGE), ...(q ? { q } : {}) })}`);
    res.render("scraper-records", { title: "Images, news & brands", data, entityType, status, q, page, pages: Math.ceil(data.total / PAGE) });
  }),
);

// ---- Review and import actions ----
scraperRouter.post(
  "/records/:id/approve",
  safe(async (req, res) => {
    try {
      const r = await scraper(`/records/${req.params.id}/approve`, { method: "POST", body: { reviewer: req.session.user.email }, timeout: 180000 });
      await audit(req, "scraper-approve", "scraper_record", req.params.id, r.record.title);
      flash(req, "ok", `Approved. ${r.result?.note ?? ""} Now you can import it into the CMS.`);
    } catch (err) {
      flash(req, "err", `Not approved: ${err.message}`);
    }
    res.redirect(back(req, "/admin/scraper/cars"));
  }),
);

scraperRouter.post(
  "/records/:id/reject",
  safe(async (req, res) => {
    try {
      await scraper(`/records/${req.params.id}/reject`, { method: "POST", body: { reviewer: req.session.user.email, note: String(req.body.note ?? "") } });
      await audit(req, "scraper-reject", "scraper_record", req.params.id);
      flash(req, "ok", "Rejected. It will not be imported.");
    } catch (err) {
      flash(req, "err", err.message);
    }
    res.redirect(back(req, "/admin/scraper/cars"));
  }),
);

scraperRouter.post(
  "/records/bulk",
  safe(async (req, res) => {
    const ids = [].concat(req.body.ids ?? []).filter(Boolean);
    if (!ids.length) {
      flash(req, "err", "Tick at least one record first.");
      return res.redirect(back(req, "/admin/scraper/records"));
    }
    if (req.body.do === "approve") {
      const r = await scraper("/records/approve", { method: "POST", body: { ids, reviewer: req.session.user.email }, timeout: 600000 });
      flash(req, r.failed.length ? "err" : "ok", `Approved ${r.approved}.${r.failed.length ? ` ${r.failed.length} failed: ${r.failed[0].error}` : ""}`);
    } else if (req.body.do === "import") {
      let ok = 0;
      const failed = [];
      for (const id of ids) {
        try {
          const r = await importRecord(req, id);
          if (r.status === "done") ok++;
          else failed.push("an existing car needs confirmation (open it to review the changes)");
        } catch (err) {
          failed.push(err.message);
        }
      }
      flash(req, failed.length ? "err" : "ok", `Imported ${ok}.${failed.length ? ` ${failed.length} not imported: ${failed[0]}` : ""}`);
    } else if (req.body.do === "reject") {
      for (const id of ids) await scraper(`/records/${id}/reject`, { method: "POST", body: { reviewer: req.session.user.email } }).catch(() => {});
      flash(req, "ok", `Rejected ${ids.length}.`);
    }
    res.redirect(back(req, "/admin/scraper/records"));
  }),
);

scraperRouter.post(
  "/records/:id/import",
  safe(async (req, res) => {
    try {
      const r = await importRecord(req, req.params.id, { confirm: req.body.confirm === "yes" });
      if (r.status === "awaiting_confirmation") flash(req, "info", "This car already exists in the CMS. Review the changes below and confirm to update it.");
      else if (r.action === "skip") flash(req, "ok", r.message);
      else if (r.result?.cmsEntity === "cars") flash(req, "ok", `${r.action === "create" ? "Created a new hidden car" : "Updated the car"} with ${r.result.variants} variants and ${r.result.photos} photos. Open it in Cars to review and publish.`);
      else flash(req, "ok", `Imported into ${r.result.cmsEntity}.`);
    } catch (err) {
      flash(req, "err", `Import failed: ${err.message}. You can retry from Import history.`);
    }
    res.redirect(back(req, "/admin/scraper/cars"));
  }),
);

// ---- Sources ----
scraperRouter.get(
  "/sources",
  safe(async (req, res) => {
    const sources = await scraper("/sources");
    res.render("scraper-sources", { title: "Scraper sources", sources });
  }),
);

scraperRouter.get(
  "/sources/new",
  safe(async (req, res) => res.render("scraper-source", { title: "Add source", s: { kind: "html", adapter: "manufacturer", enabled: false, rateLimitMs: 3000, timeoutMs: 20000, concurrency: 1, headers: {}, selectors: {}, config: {}, permissions: [] }, isNew: true, test: null })),
);

scraperRouter.get(
  "/sources/:id",
  safe(async (req, res) => {
    const s = await scraper(`/sources/${req.params.id}`);
    res.render("scraper-source", { title: s.name, s, isNew: false, test: req.session.lastTest?.id === s.id ? req.session.lastTest.result : null });
  }),
);

function sourceBody(b, isNew) {
  const json = (v, name) => {
    try {
      return v?.trim() ? JSON.parse(v) : {};
    } catch {
      throw new Error(`${name} is not valid JSON.`);
    }
  };
  return {
    ...(isNew ? { key: b.key } : {}),
    name: b.name,
    description: b.description ?? "",
    kind: b.kind,
    adapter: b.adapter,
    baseUrl: b.baseUrl,
    enabled: b.enabled === "on",
    schedule: b.schedule?.trim() || null,
    concurrency: Number(b.concurrency) || 1,
    rateLimitMs: Number(b.rateLimitMs) || 1500,
    timeoutMs: Number(b.timeoutMs) || 20000,
    headers: json(b.headers, "Headers"),
    selectors: json(b.selectors, "Selectors"),
    config: json(b.config, "Config"),
  };
}

scraperRouter.post(
  "/sources",
  safe(async (req, res) => {
    try {
      const s = await scraper("/sources", { method: "POST", body: sourceBody(req.body, true) });
      await audit(req, "create", "scraper_source", s.id, s.name);
      flash(req, "ok", "Source added. Record its permission below before enabling it.");
      res.redirect(`/admin/scraper/sources/${s.id}`);
    } catch (err) {
      flash(req, "err", `Not saved: ${err.message}`);
      res.redirect("/admin/scraper/sources/new");
    }
  }),
);

scraperRouter.post(
  "/sources/:id",
  safe(async (req, res) => {
    try {
      await scraper(`/sources/${req.params.id}`, { method: "PUT", body: sourceBody(req.body, false) });
      await audit(req, "update", "scraper_source", req.params.id, req.body.name);
      flash(req, "ok", "Source saved. Schedule changes apply at once.");
    } catch (err) {
      flash(req, "err", `Not saved: ${err.message}`);
    }
    res.redirect(`/admin/scraper/sources/${req.params.id}`);
  }),
);

scraperRouter.post(
  "/sources/:id/toggle",
  safe(async (req, res) => {
    const s = await scraper(`/sources/${req.params.id}`);
    try {
      await scraper(`/sources/${req.params.id}`, { method: "PUT", body: { enabled: !s.enabled } });
      await audit(req, s.enabled ? "disable" : "enable", "scraper_source", s.id, s.name);
      flash(req, "ok", `${s.name} ${s.enabled ? "disabled" : "enabled"}.`);
    } catch (err) {
      flash(req, "err", err.message);
    }
    res.redirect(back(req, "/admin/scraper/sources"));
  }),
);

scraperRouter.post(
  "/sources/:id/delete",
  safe(async (req, res) => {
    await scraper(`/sources/${req.params.id}`, { method: "DELETE" });
    await audit(req, "delete", "scraper_source", req.params.id);
    flash(req, "ok", "Source removed. Its collected records stay for review.");
    res.redirect("/admin/scraper/sources");
  }),
);

scraperRouter.post(
  "/sources/:id/run",
  safe(async (req, res) => {
    try {
      const job = await scraper("/jobs", { method: "POST", body: { sourceId: req.params.id, type: req.body.type === "full" ? "full" : "incremental" } });
      await audit(req, "run", "scraper_source", req.params.id);
      flash(req, "ok", "Started. Refresh the page to follow progress.");
      return res.redirect(`/admin/scraper/jobs/${job.id}`);
    } catch (err) {
      flash(req, "err", err.message);
      res.redirect(back(req, "/admin/scraper/sources"));
    }
  }),
);

scraperRouter.post(
  "/sources/:id/test",
  safe(async (req, res) => {
    const result = await scraper(`/sources/${req.params.id}/test`, { method: "POST", body: { limit: 3 }, timeout: 180000 });
    req.session.lastTest = { id: req.params.id, result };
    flash(req, result.ok ? "ok" : "err", result.ok ? `Test passed: ${result.items.length} items read and valid. Nothing was saved.` : `Test did not pass: ${result.error ?? "see the items below"}`);
    res.redirect(`/admin/scraper/sources/${req.params.id}#test`);
  }),
);

scraperRouter.post(
  "/sources/:id/permissions",
  safe(async (req, res) => {
    try {
      const b = req.body;
      await scraper(`/sources/${req.params.id}/permissions`, { method: "POST", body: { hostname: b.hostname?.trim(), pathPrefix: b.pathPrefix?.trim() || "/", allowData: b.allowData === "on", allowImages: b.allowImages === "on", basis: b.basis, licence: b.licence ?? "", evidence: b.evidence ?? "", expiresAt: b.expiresAt || null } });
      await audit(req, "add-permission", "scraper_source", req.params.id, `${b.hostname} (${b.basis})`);
      flash(req, "ok", "Permission recorded.");
    } catch (err) {
      flash(req, "err", `Not saved: ${err.message}`);
    }
    res.redirect(`/admin/scraper/sources/${req.params.id}#permissions`);
  }),
);

scraperRouter.post(
  "/sources/:id/permissions/:pid/delete",
  safe(async (req, res) => {
    await scraper(`/sources/${req.params.id}/permissions/${req.params.pid}`, { method: "DELETE" });
    await audit(req, "remove-permission", "scraper_source", req.params.id);
    flash(req, "ok", "Permission removed. The source can no longer fetch from that host.");
    res.redirect(`/admin/scraper/sources/${req.params.id}#permissions`);
  }),
);

// ---- Jobs ----
scraperRouter.get(
  "/jobs",
  safe(async (req, res) => {
    const jobs = await scraper(`/jobs?limit=100${req.query.sourceId ? `&sourceId=${encodeURIComponent(req.query.sourceId)}` : ""}`);
    res.render("scraper-jobs", { title: "Scraping jobs", jobs });
  }),
);

scraperRouter.get(
  "/jobs/:id",
  safe(async (req, res) => {
    const job = await scraper(`/jobs/${req.params.id}`);
    if (req.query.format === "json") return res.json({ status: job.status, stats: job.stats, logs: job.logs.slice(-200) });
    res.render("scraper-job", { title: `Job: ${job.source.name}`, job });
  }),
);

scraperRouter.post(
  "/jobs/:id/retry",
  safe(async (req, res) => {
    try {
      const job = await scraper(`/jobs/${req.params.id}/retry`, { method: "POST" });
      flash(req, "ok", "Retry started.");
      return res.redirect(`/admin/scraper/jobs/${job.id}`);
    } catch (err) {
      flash(req, "err", err.message);
      res.redirect(back(req, "/admin/scraper/jobs"));
    }
  }),
);

scraperRouter.post(
  "/jobs/:id/cancel",
  safe(async (req, res) => {
    await scraper(`/jobs/${req.params.id}/cancel`, { method: "POST" }).catch(() => {});
    flash(req, "ok", "Job cancelled.");
    res.redirect(back(req, "/admin/scraper/jobs"));
  }),
);

// ---- Import history ----
scraperRouter.get(
  "/imports",
  safe(async (req, res) => {
    const status = ["done", "failed", "awaiting_confirmation"].includes(req.query.status) ? req.query.status : "";
    const list = await rows(`SELECT i.*, u.name AS user_name FROM scraper_imports i LEFT JOIN users u ON u.id = i.user_id ${status ? "WHERE i.status = $1" : ""} ORDER BY i.id DESC LIMIT 300`, status ? [status] : []);
    let approved = [];
    try {
      approved = await scraper("/approved?limit=300");
    } catch (err) {
      if (!(err instanceof ScraperUnavailable)) throw err;
    }
    res.render("scraper-imports", { title: "Import history", list, status, approved });
  }),
);

scraperRouter.post(
  "/imports/:id/retry",
  safe(async (req, res) => {
    const row = await one("SELECT * FROM scraper_imports WHERE id = $1", [req.params.id]);
    if (!row) return res.redirect("/admin/scraper/imports");
    try {
      const r = await importRecord(req, row.record_id, { confirm: row.action === "update" && req.body.confirm === "yes" });
      flash(req, r.status === "done" ? "ok" : "info", r.status === "done" ? "Imported." : "This car exists already: open it to confirm the changes.");
    } catch (err) {
      flash(req, "err", `Still failing: ${err.message}`);
    }
    res.redirect("/admin/scraper/imports");
  }),
);
