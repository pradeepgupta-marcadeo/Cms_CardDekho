// Background schedule, while the CMS is running:
//  - news leads every 3 hours; the news scraper writes original articles twice a day (Settings)
// Car data comes only from CarScrapper, which has its own schedule (src/lib/carscraper.js).
import { getSetting, setSetting } from "../db.js";
import { runNews } from "../importers/news.js";
import { runNewsScrape } from "../lib/news-scraper.js";
import { runNow } from "../lib/runs.js";

const HOUR = 3600 * 1000;

async function tick() {
  const last = await getSetting("scheduler", {});
  const now = Date.now();
  const save = (k) => {
    last[k] = now;
    return setSetting("scheduler", last);
  };

  if (!last.news || now - last.news > 3 * HOUR) {
    await save("news");
    await runNow("news", async (log) => {
      const summary = await runNews({ log });
      return summary;
    });
  }
  // The one-click news scraper, on its own: a few original articles twice a day (the editor can still press the button).
  const auto = await getSetting("auto_draft", { enabled: true, perRun: 5, publish: false });
  if (auto.enabled && (!last.autonews || now - last.autonews > 11 * HOUR)) {
    await save("autonews");
    await runNow("news-auto", (log) => runNewsScrape({ hours: 24, limit: auto.perRun ?? 5, publish: Boolean(auto.publish), log }));
  }
  // Car data, fuel prices and the old car collector are no longer imported here: all car data comes from
  // CarScrapper (its own schedule, see src/lib/carscraper.js).
}

export function startScheduler() {
  const safeTick = () => tick().catch((err) => console.error("Scheduler:", err.message));
  setTimeout(safeTick, 20000);
  setInterval(safeTick, 10 * 60 * 1000);
  console.log("Scheduler on: news leads every 3 hours, news scraper twice a day. Car data: CarScrapper schedule.");
}
