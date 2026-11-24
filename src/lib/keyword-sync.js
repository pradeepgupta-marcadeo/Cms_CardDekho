// Keeps the keyword bank in step with the website: every car, tab, variant, city price page and comparison that is
// live on the site gets its search phrases (head terms and long-tail), and phrases aimed at pages that no longer
// exist are removed. Runs after every catalogue sync, so newly scraped cars get keywords without anyone typing them.
import { query } from "../db.js";
import { carKeywords, siteKeywords } from "./keywords.js";
import { buildSnapshot } from "./snapshot.js";

/** All phrases for the live site, one page per phrase: when two cars could claim a phrase, the more popular wins. */
export function bankFor(snap) {
  const year = new Date(snap.generatedAt).getFullYear();
  const cars = [...snap.cars].sort((a, b) => b.popularity - a.popularity);
  const byKey = new Map(cars.map((c) => [c.key, c]));
  const rivals = new Map();
  for (const [a, b] of snap.comparePairs ?? []) {
    if (!byKey.has(a) || !byKey.has(b)) continue;
    const pairSlug = `${a}-vs-${b}`;
    rivals.set(a, [...(rivals.get(a) ?? []), { name: byKey.get(b).name, pairSlug }]);
    rivals.set(b, [...(rivals.get(b) ?? []), { name: byKey.get(a).name, pairSlug }]);
  }
  const all = [...siteKeywords(snap.cities)];
  for (const c of cars) {
    const car = { brand: c.brand, brandSlug: c.brandSlug, name: c.name, slug: c.slug, status: c.status, fuels: c.fuels, auto: c.auto, hasMileage: /\d/.test(c.mileage ?? "") };
    all.push(...carKeywords(car, { cities: snap.cities, rivals: rivals.get(c.key) ?? [], variants: c.variants ?? [], year }));
  }
  const byPhrase = new Map();
  for (const k of all) if (k.phrase.length >= 3 && !byPhrase.has(k.phrase)) byPhrase.set(k.phrase, k);
  return [...byPhrase.values()];
}

export async function syncKeywordBank(log = () => {}) {
  const snap = await buildSnapshot();
  const list = bankFor(snap);
  // Phrases an editor added by hand (any source other than "pattern") are never changed or removed.
  const res = await query(
    `INSERT INTO keywords (phrase, intent, priority, target_path, source)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(phrase, intent, priority, target_path), (SELECT 'pattern') s(source)
     ON CONFLICT (phrase) DO UPDATE SET intent = EXCLUDED.intent, priority = EXCLUDED.priority, target_path = EXCLUDED.target_path
     WHERE keywords.source = 'pattern' AND (keywords.target_path, keywords.priority, keywords.intent) IS DISTINCT FROM (EXCLUDED.target_path, EXCLUDED.priority, EXCLUDED.intent)`,
    [list.map((k) => k.phrase), list.map((k) => k.intent), list.map((k) => k.priority), list.map((k) => k.target_path)],
  );
  const gone = await query("DELETE FROM keywords WHERE source = 'pattern' AND NOT (phrase = ANY($1::text[]))", [list.map((k) => k.phrase)]);
  const pages = new Set(list.map((k) => k.target_path)).size;
  log(`Keywords: ${list.length} phrases for ${pages} pages (${res.rowCount} added or re-aimed, ${gone.rowCount} for pages that no longer exist removed).`);
  return { phrases: list.length, pages, changed: res.rowCount, removed: gone.rowCount };
}
