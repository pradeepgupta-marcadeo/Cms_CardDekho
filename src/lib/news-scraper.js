// The run behind the "Run scraper" button and the scheduler: read the permitted car-news feeds,
// drop what is already done, group one story reported by several sources, and write an original
// draft for the newest ones. Each step logs one line, so the screen can show it as it happens.
//
// Line prefixes (the screen colours by them): Fetching, Scraped, Cleaned, Processing, Writing,
// Saved, Dropped, Using, Stopped, Done, ERROR.
import { query, rows } from "../db.js";
import { carMatcher, fromGdelt, fromRss, isCarStory, isLaunchTitle, newsParser, sourcesList } from "../importers/news.js";
import { aiStatus } from "./ai.js";
import { CATEGORY, draftFromLead } from "./drafts.js";
import { groupLeads, sameStory } from "./news-text.js";
import { contentChanged } from "./publish.js";

export const SCRAPE_CATEGORIES = { "": "All car news", launch: "Launches", pricing: "Pricing", safety: "Safety", sales: "Sales", spy: "Spy shots", comparison: "Comparisons", discount: "Discounts" };

const noQuery = (u) => String(u).split("?")[0];
const clampNum = (n, lo, hi, d) => Math.min(hi, Math.max(lo, Number.parseInt(n, 10) || d));

/**
 * @param {{category?: string, hours?: number, limit?: number, publish?: boolean, log?: (line: string) => void, stopped?: () => boolean}} o
 * @returns {Promise<{found: number, skipped: number, written: number, failed: number}>}
 */
export async function runNewsScrape({ category = "", hours = 24, limit = 10, publish = false, log = () => {}, stopped = () => false } = {}) {
  const out = { found: 0, skipped: 0, written: 0, failed: 0 };
  hours = clampNum(hours, 1, 168, 24);
  const want = clampNum(limit, 1, 25, 10);

  if (!aiStatus().some((p) => p.configured)) {
    log("ERROR  No AI key is set. Add GEMINI_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY) to cms_cardekho/.env and restart.");
    return out;
  }
  const sources = (await sourcesList()).filter((s) => s.enabled);
  if (!sources.length) {
    log("ERROR  No news feeds are switched on (Settings > News sources).");
    return out;
  }

  // 1. Read every feed at once.
  log(`Fetching  ${sources.length} car news feeds, last ${hours}h`);
  const parser = newsParser();
  const since = Date.now() - hours * 3600 * 1000;
  const matchCar = await carMatcher();
  const perFeed = await Promise.all(
    sources.map(async (s) => {
      try {
        const items = s.url === "gdelt" ? await fromGdelt() : await fromRss(s, parser);
        const inside = items.filter((i) => !i.published_at || new Date(i.published_at).getTime() >= since);
        log(`Fetching  ${s.name} - ${items.length} items, ${inside.length} inside ${hours}h`);
        return inside;
      } catch (err) {
        log(`ERROR  ${s.name}: ${err.message}`);
        return [];
      }
    }),
  );

  // 2. Keep car stories, once per URL, and remember them in the inbox too.
  const seenUrl = new Set();
  let leads = [];
  for (const item of perFeed.flat()) {
    if (!isCarStory(item) || seenUrl.has(noQuery(item.url))) continue;
    seenUrl.add(noQuery(item.url));
    leads.push(item);
  }
  out.found = leads.length;
  log(`Scraped  ${leads.length} leads`);
  if (!leads.length) {
    log("Done - nothing new in that window");
    return out;
  }
  for (const l of leads) {
    await query(
      "INSERT INTO news_leads (url, title, source, published_at, summary, car_id, is_launch, image_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (url) DO UPDATE SET image_url = COALESCE(news_leads.image_url, EXCLUDED.image_url)",
      [l.url, l.title.slice(0, 300), l.source, l.published_at ? new Date(l.published_at) : null, l.summary, matchCar(l.title), isLaunchTitle(l.title), l.image ?? null],
    );
  }

  // 3. Drop what was already written or ignored by an editor.
  const known = new Map((await rows("SELECT id, url, status, article_id FROM news_leads WHERE url = ANY($1)", [leads.map((l) => l.url)])).map((r) => [r.url, r]));
  const before = leads.length;
  leads = leads.filter((l) => known.get(l.url)?.status === "new" && !known.get(l.url)?.article_id).map((l) => ({ ...l, id: known.get(l.url).id }));
  if (before - leads.length) log(`Cleaned  ${before - leads.length} already imported or ignored`);
  if (category) {
    const n = leads.length;
    leads = leads.filter((l) => CATEGORY(l.title) === category);
    log(`Cleaned  ${n - leads.length} outside ${SCRAPE_CATEGORIES[category] ?? category}`);
  }

  // 4. One story carried by several sources becomes one group.
  const groups = groupLeads(leads);
  const merged = leads.length - groups.length;
  if (merged > 0) log(`Cleaned  ${merged} stories carried by more than one source`);
  // Launches first, then newest.
  groups.sort((a, b) => Number(isLaunchTitle(b[0].title)) - Number(isLaunchTitle(a[0].title)));
  const todo = groups.slice(0, want * 3);
  if (groups.length > want) log(`Writing  the newest ${want} of ${groups.length}; run again for the rest`);

  // Every article we hold (any age, draft or published), to refuse a second article on the same story:
  // compared by headline and SEO title, and by car + kind of story + date (see sameStory).
  const recent = (
    await rows(`SELECT title, seo->>'title' AS seo_title, slug, car_id, category, COALESCE(published_on, created_at::date) AS day FROM articles`)
  ).flatMap((a) => [a.title, a.seo_title].filter(Boolean).map((title) => ({ title, slug: a.slug, carId: a.car_id, category: a.category, date: a.day })));

  for (const [i, group] of todo.entries()) {
    if (stopped()) {
      log("Stopped by user");
      return out;
    }
    if (out.written >= want) break;
    const lead = group[0];
    log(`Processing  [${i + 1}/${todo.length}] ${lead.title.slice(0, 70)}`);
    const me = { title: lead.title, carId: matchCar(lead.title), category: CATEGORY(lead.title), date: lead.published_at ?? new Date() };
    const twin = recent.find((a) => sameStory(me, a));
    if (twin) {
      out.skipped++;
      await query("UPDATE news_leads SET status = 'ignored' WHERE id = ANY($1)", [group.map((g) => g.id)]);
      log(`Dropped  [${i + 1}/${todo.length}] we already have this story (/${twin.slug})`);
      continue;
    }
    try {
      const result = {};
      const id = await draftFromLead(null, lead.id, { sources: group.slice(1), publish, log: (line) => log(line.replace(/^(\S+)\s+/, (m, p) => `${p}  [${i + 1}/${todo.length}] `)), out: result });
      recent.push({ ...me, slug: String(id) });
      out.written++;
      log(`Saved  [${i + 1}/${todo.length}] ${lead.title.slice(0, 70)} (${result.words} words${result.status === "published" ? ", published" : ""})`);
    } catch (err) {
      if (err.code === "DUPLICATE") {
        // The AI's version turned out to repeat an article we already have: not saved, and not tried again.
        out.skipped++;
        await query("UPDATE news_leads SET status = 'ignored' WHERE id = ANY($1)", [group.map((g) => g.id)]);
        log(`Dropped  [${i + 1}/${todo.length}] ${err.message}`);
        continue;
      }
      if (err.code === "NO_IMAGE") {
        // Not marked as ignored: a later run may find the picture.
        out.skipped++;
        log(`Dropped  [${i + 1}/${todo.length}] ${err.message}`);
        continue;
      }
      out.failed++;
      log(`ERROR  [${i + 1}/${todo.length}] ${String(err.message).slice(0, 140)}`);
    }
  }
  if (out.written) await contentChanged();
  log(`Done - ${out.written} written, ${out.skipped} skipped, ${out.failed} failed`);
  return out;
}
