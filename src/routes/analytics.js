import { Router } from "express";
import { getSetting, one, rows } from "../db.js";

export const analyticsRouter = Router();

analyticsRouter.get("/", async (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const since = `now() - interval '${days} days'`;
  const totals = await one(`SELECT count(*) FILTER (WHERE type = 'pageview')::int AS views, count(DISTINCT visitor) FILTER (WHERE type = 'pageview')::int AS visitors, count(*) FILTER (WHERE type = 'click')::int AS clicks FROM analytics_events WHERE ts > ${since}`);
  const daily = await rows(`SELECT to_char(date_trunc('day', ts), 'DD Mon') AS day, count(*) FILTER (WHERE type = 'pageview')::int AS views FROM analytics_events WHERE ts > ${since} GROUP BY date_trunc('day', ts) ORDER BY date_trunc('day', ts)`);
  const pages = await rows(`SELECT path, count(*)::int AS views, count(DISTINCT visitor)::int AS visitors FROM analytics_events WHERE type = 'pageview' AND ts > ${since} GROUP BY path ORDER BY views DESC LIMIT 25`);
  const clicks = await rows(`SELECT target, count(*)::int AS n, count(DISTINCT path)::int AS pages FROM analytics_events WHERE type = 'click' AND ts > ${since} GROUP BY target ORDER BY n DESC LIMIT 25`);
  const refs = await rows(`SELECT COALESCE(NULLIF(referrer, ''), 'Direct / unknown') AS referrer, count(*)::int AS n FROM analytics_events WHERE type = 'pageview' AND ts > ${since} GROUP BY 1 ORDER BY n DESC LIMIT 15`);
  const devices = await rows(`SELECT COALESCE(device, 'unknown') AS device, count(*)::int AS n FROM analytics_events WHERE type = 'pageview' AND ts > ${since} GROUP BY 1 ORDER BY n DESC`);
  res.render("analytics", { title: "Analytics", days, totals, daily, pages, clicks, refs, devices, settings: await getSetting("analytics", {}) });
});
