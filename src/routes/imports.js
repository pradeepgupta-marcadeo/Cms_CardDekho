import { Router } from "express";
import { config } from "../config.js";
import { one, rows } from "../db.js";
import { runNews } from "../importers/news.js";
import { runOpenChargeMap } from "../importers/opencharge.js";
import { runOsm } from "../importers/osm.js";
import { runPpac } from "../importers/ppac.js";
import { runVariantwise } from "../importers/variantwise.js";
import { localizeAll } from "../lib/localize.js";
import { contentChanged } from "../lib/publish.js";
import { startRun } from "../lib/runs.js";

export const importsRouter = Router();

const withRefresh = (fn) => async (log) => {
  const r = await fn(log);
  await contentChanged();
  return r;
};

export const IMPORTERS = {
  variantwise: {
    title: "Car prices, variants & specs (VariantWise)",
    what: "219 Indian models, 1,600+ variants: ex-showroom prices, engines, power, mileage/range, dimensions, boot, 60+ features per trim, and state road-tax slabs for on-road prices.",
    effect: "Updates the price, specs and variants of existing cars with real data. New models we do not have yet are added as 'hidden' cars: add a photo, then publish them.",
    license: "CC BY 4.0. The website shows the 'Data: VariantWise' credit by itself.",
    schedule: "Every Monday",
    run: withRefresh((log) => runVariantwise({ log })),
  },
  ppac: {
    title: "Petrol & diesel prices (PPAC, Government of India)",
    what: "Official daily retail prices for Delhi, Mumbai, Chennai and Kolkata.",
    effect: "Today's rates for these cities on the Fuel prices page. Other cities and CNG are added by hand in 'Fuel prices'.",
    license: "Government data, free to reuse with credit.",
    schedule: "Every morning after 6:30",
    run: withRefresh((log) => runPpac({ log })),
  },
  osm: {
    title: "Fuel pumps, EV chargers & showrooms (OpenStreetMap)",
    what: "Real places within 12 km of each city centre: names, addresses, opening hours, fuel types, charger connectors.",
    effect: "Real places on the Fuel stations, EV charging stations and Dealers pages. A dealer is added only when its name shows the brand.",
    license: "© OpenStreetMap contributors (ODbL). The credit is shown on the website.",
    schedule: "Run by hand (monthly is enough)",
    run: withRefresh((log) => runOsm({ log })),
  },
  opencharge: {
    title: "EV chargers (Open Charge Map)",
    what: "Public EV chargers with connector types and power.",
    effect: "More chargers on the EV charging stations page.",
    license: "CC BY 4.0 (contributors). Needs a free key in .env (OPENCHARGEMAP_API_KEY).",
    schedule: "Run by hand",
    needsKey: !config.openChargeMapKey,
    run: withRefresh((log) => runOpenChargeMap({ log })),
  },
  photos: {
    title: "Self-host car photos (faster pages)",
    what: "Copies photos that still load from Wikimedia Commons into the CMS as compressed WebP files, keeping each photo's credit and licence.",
    effect: "Website photos load in a smaller size that fits each screen, so pages open faster (better LCP).",
    license: "Same licence as each original photo (credited on Image credits).",
    schedule: "Run by hand after adding many photos",
    run: withRefresh((log) => localizeAll({ log })),
  },
  news: {
    title: "News leads (RSS feeds + GDELT)",
    what: "Latest car headlines with links from Indian auto news sites.",
    effect: "New leads in the News inbox. Nothing changes on the website until you publish an AI draft.",
    license: "Only headline + link are stored; articles are written fresh.",
    schedule: "Every 3 hours",
    run: (log) => runNews({ log }),
  },
};

importsRouter.get("/", async (req, res) => {
  const last = {};
  for (const k of Object.keys(IMPORTERS)) last[k] = await one("SELECT id, status, started_at, finished_at, summary FROM import_runs WHERE kind = $1 ORDER BY id DESC LIMIT 1", [k]);
  res.render("imports", { title: "Import free data", IMPORTERS, last, runs: await rows("SELECT id, kind, status, started_at, finished_at FROM import_runs ORDER BY id DESC LIMIT 15") });
});

importsRouter.post("/:kind", async (req, res, next) => {
  const imp = IMPORTERS[req.params.kind];
  if (!imp) return next();
  if (imp.needsKey) {
    req.session.flash = { type: "err", text: "Add the API key to .env first, then restart the CMS." };
    return res.redirect("/admin/imports");
  }
  const id = await startRun(req.params.kind, imp.run);
  res.redirect(`/admin/imports/runs/${id}`);
});

importsRouter.get("/runs/:id", async (req, res, next) => {
  const run = await one("SELECT * FROM import_runs WHERE id = $1", [req.params.id]);
  if (!run) return next();
  if (req.query.format === "json") return res.json(run);
  res.render("run", { title: `Import: ${run.kind}`, run, imp: IMPORTERS[run.kind] });
});
