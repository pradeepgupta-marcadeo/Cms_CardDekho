// Collects car news leads (headline, link, date, short summary) from public RSS
// feeds and GDELT. Leads are never published as they are: an editor, or the
// optional auto-draft step, turns one into an original article with AI.
import Parser from "rss-parser";
import { config } from "../config.js";
import { getSetting, query, rows } from "../db.js";
import { fetchWithRetry, getJson } from "../lib/http.js";

export const DEFAULT_SOURCES = [
  { name: "Rushlane", url: "https://www.rushlane.com/feed", enabled: true },
  { name: "GaadiWaadi", url: "https://gaadiwaadi.com/feed/", enabled: true },
  { name: "MotorBeam", url: "https://www.motorbeam.com/feed/", enabled: true },
  { name: "Autox", url: "https://www.autox.com/feed/", enabled: true },
  { name: "CarToq", url: "https://www.cartoq.com/feed/", enabled: true },
  { name: "GDELT (Indian news sites)", url: "gdelt", enabled: true },
];

const LAUNCH = /\b(launch(ed|es)?|unveil(ed|s)?|debut(s|ed)?|revealed|price(s)? announced|bookings? open|introduced)\b/i;
const CAR_WORDS = /\b(cars?|suvs?|sedans?|hatchbacks?|mpvs?|evs?|electric|launch|price|variant|facelift|model|bookings?|ncap|mileage|engine|diesel|petrol|cng|hybrid|sales)\b/i;
const NOT_CARS = /\b(used[- ]cars?|second[- ]hand|pre-?owned|sell(ing)? (your |my |a )?(old )?car|videos?|bikes?|motorcycles?|motorbikes?|scooters?|two-wheelers?|2-wheelers?|superbikes?|cruisers?|trucks?|bus|buses|tractors?|helmets?|ducati|kawasaki|royal enfield|bajaj|tvs|hero motocorp|yamaha|ktm|triumph|harley|kove|ather|ola electric|hero|honda (activa|shine|unicorn|hornet)|inline-(four|twin)|rr\b|cc engine)\b/i;
const strip = (s) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "'").replace(/&#8216;|&lsquo;/g, "'").replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/&#8211;|&#8212;/g, "-").replace(/&#\d+;/g, " ").replace(/\s+/g, " ").trim();

// Portals whose terms forbid automated copying are never read, whatever the saved list says.
const FORBIDDEN_HOSTS = /(^|\.)(cardekho|carwale|zigwheels|autocarindia|carandbike|team-bhp)\.com$/i;
export const isForbidden = (url) => {
  try {
    return FORBIDDEN_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

export const sourcesList = async () => (await getSetting("news_sources", DEFAULT_SOURCES)).filter((s) => s.url === "gdelt" || !isForbidden(s.url));

/** RSS parser that keeps the picture fields (media:content, media:thumbnail) feeds attach to each item. */
export const newsParser = () =>
  new Parser({ timeout: 20000, customFields: { item: [["media:content", "media", { keepArray: true }], ["media:thumbnail", "mediaThumb", { keepArray: true }], ["content:encoded", "contentEncoded"]] } });

export const isImageUrl = (u) => /^https?:\/\//i.test(u ?? "") && !/\.(mp4|webm|mp3|m4a|pdf)(\?|$)/i.test(u);

/** The picture a feed offers for one story: media tags first, then an image enclosure, then the first <img> in the body. */
export function feedImage(i) {
  const media = [...(i.media ?? []), ...(i.mediaThumb ?? [])].map((m) => m?.$ ?? m).filter((m) => m?.url && (!m.medium || m.medium === "image") && (!m.type || /^image\//.test(m.type)));
  media.sort((a, b) => Number(b.width ?? 0) - Number(a.width ?? 0));
  if (media[0] && isImageUrl(media[0].url)) return media[0].url;
  if (i.enclosure?.url && /^image\//.test(i.enclosure.type ?? "image/") && isImageUrl(i.enclosure.url)) return i.enclosure.url;
  const img = String(i.contentEncoded ?? i.content ?? "").match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
  return img && isImageUrl(img) ? img : null;
}

export async function fromRss(source, parser) {
  const res = await fetchWithRetry(source.url, { timeout: 20000, tries: 2, headers: { accept: "application/rss+xml, application/xml, text/xml" } });
  if (!res.ok) throw new Error(`${res.status}`);
  const feed = await parser.parseString(await res.text());
  return feed.items.map((i) => ({ url: i.link, title: strip(i.title), source: source.name, published_at: i.isoDate ?? i.pubDate ?? null, summary: strip(i.contentSnippet ?? i.content ?? i.summary).slice(0, 600), image: feedImage(i) }));
}

export async function fromGdelt() {
  const q = '(maruti OR "tata motors" OR mahindra OR hyundai OR kia OR toyota OR "mg motor" OR skoda OR honda) (car OR suv OR launch) sourcecountry:IN sourcelang:english';
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?${new URLSearchParams({ query: q, mode: "artlist", format: "json", maxrecords: "50", timespan: "3d", sort: "datedesc" })}`;
  const json = await getJson(url, { timeout: 30000, tries: 2 });
  return (json.articles ?? []).map((a) => ({
    url: a.url,
    title: strip(a.title),
    source: `${a.domain} (via GDELT)`,
    published_at: a.seendate ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}T${a.seendate.slice(9, 11)}:${a.seendate.slice(11, 13)}:00Z` : null,
    summary: "",
    image: isImageUrl(a.socialimage) ? a.socialimage : null,
  }));
}

export const isCarStory = (item) => Boolean(item.url && item.title && !NOT_CARS.test(item.title) && CAR_WORDS.test(`${item.title} ${item.summary}`));
export const isLaunchTitle = (title) => LAUNCH.test(title);
export const newsStrip = strip;

/** Matches a headline to a catalogue car: the car named first wins ("Creta outsells Seltos" is about the Creta). */
export async function carMatcher() {
  const cars = await rows("SELECT c.id, c.name FROM cars c");
  // Longest names first, so "Creta Electric" matches before "Creta".
  const matchers = cars.map((c) => ({ id: c.id, re: new RegExp(`\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]?")}\\b`, "i"), len: c.name.length })).sort((a, b) => b.len - a.len);
  return (title) => matchers.map((m) => ({ m, at: title.search(m.re) })).filter((x) => x.at >= 0).sort((p, q) => p.at - q.at || q.m.len - p.m.len)[0]?.m.id ?? null;
}

export async function runNews({ log = () => {} } = {}) {
  const sources = (await sourcesList()).filter((s) => s.enabled);
  const parser = newsParser();
  const cars = await rows("SELECT c.id, c.name, b.name AS brand FROM cars c JOIN brands b ON b.id = c.brand_id");
  // Longest names first, so "Creta Electric" matches before "Creta".
  const matchers = cars.map((c) => ({ id: c.id, re: new RegExp(`\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]?")}\\b`, "i"), len: c.name.length })).sort((a, b) => b.len - a.len);
  const summary = { sources: {}, added: 0, launches: 0 };
  for (const s of sources) {
    try {
      const items = s.url === "gdelt" ? await fromGdelt() : await fromRss(s, parser);
      let added = 0;
      for (const item of items) {
        if (!item.url || !item.title || NOT_CARS.test(item.title) || !CAR_WORDS.test(`${item.title} ${item.summary}`)) continue;
        // The car named first in the headline is the story's subject ("Creta outsells Seltos" is about the Creta).
        const car = matchers.map((m) => ({ m, at: item.title.search(m.re) })).filter((x) => x.at >= 0).sort((p, q) => p.at - q.at || q.m.len - p.m.len)[0]?.m;
        const isLaunch = LAUNCH.test(item.title);
        const r = await query(
          `INSERT INTO news_leads (url, title, source, published_at, summary, car_id, is_launch, image_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (url) DO UPDATE SET image_url = COALESCE(news_leads.image_url, EXCLUDED.image_url)`,
          [item.url, item.title.slice(0, 300), item.source, item.published_at ? new Date(item.published_at) : null, item.summary, car?.id ?? null, isLaunch, item.image ?? null],
        );
        if (r.rowCount) {
          added++;
          if (isLaunch) summary.launches++;
        }
      }
      summary.sources[s.name] = `${items.length} items, ${added} new`;
      summary.added += added;
      log(`${s.name}: ${items.length} items, ${added} new leads.`);
    } catch (err) {
      summary.sources[s.name] = `failed: ${err.message}`;
      log(`${s.name}: failed (${err.message}).`);
    }
  }
  return summary;
}

// Reads a story page's paragraphs so the AI has facts to work from. Pages whose
// robots.txt blocks crawlers are skipped and the feed summary is used instead.
export async function allowedByRobots(url) {
  try {
    const u = new URL(url);
    const res = await fetchWithRetry(`${u.origin}/robots.txt`, { timeout: 8000, tries: 1 });
    if (!res.ok) return true;
    let applies = false;
    for (const raw of (await res.text()).split(/\r?\n/)) {
      const line = raw.replace(/#.*/, "").trim();
      const [k, ...rest] = line.split(":");
      const v = rest.join(":").trim();
      if (/^user-agent$/i.test(k)) applies = v === "*";
      else if (applies && /^disallow$/i.test(k) && v && u.pathname.startsWith(v)) return false;
    }
    return true;
  } catch {
    return true;
  }
}

export async function readStoryFacts(url) {
  if (!(await allowedByRobots(url))) return { text: "", note: "robots.txt asks crawlers not to read this page; used the feed summary only." };
  const res = await fetchWithRetry(url, { timeout: 20000, tries: 2, headers: { accept: "text/html" } });
  if (!res.ok) return { text: "", note: `Story page answered ${res.status}.` };
  const html = (await res.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "");
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => strip(m[1])).filter((p) => p.length > 60 && !/cookie|subscribe|newsletter|©|all rights reserved/i.test(p));
  return { text: paras.join("\n").slice(0, 7000), note: "" };
}

export const newsUserAgent = () => config.userAgent;
