// Chooses the search phrases a news story should rank for. Every story gets one main keyword
// (the phrase an Indian reader would type) and several secondary and long-tail phrases.
//
// Sources, in order of strength:
//   1. the keyword bank (Keywords screen). Phrases that carry a search volume, for example
//      imported from Semrush, outrank phrases that only have a priority;
//   2. the car the story is about (price, launch date, mileage, rivals ...);
//   3. the brand and the body style named in the headline ("upcoming Hyundai SUVs");
//   4. the kind of story (launch, price, safety, sales ...).
// A main keyword already used by a news story in the last 3 days is skipped, so the site's
// stories do not compete with each other for the same phrase.
import { rows } from "../db.js";

const BODY = [
  [/\b(7|seven)[- ]seater\b/i, "7 seater cars"],
  [/\bsuvs?\b/i, "suv"],
  [/\bsedans?\b/i, "sedan"],
  [/\bhatchbacks?\b/i, "hatchback"],
  [/\b(mpv|muv)s?\b/i, "mpv"],
  [/\b(electric|evs?)\b/i, "electric car"],
  [/\bcng\b/i, "cng car"],
  [/\bhybrid\b/i, "hybrid car"],
];

const CATEGORY_PHRASES = {
  launch: ["upcoming cars in india", "new car launches in india", "car launches this month", "upcoming car launches", "new cars launching soon in india", "upcoming cars under 20 lakh"],
  pricing: ["car price hike in india", "new car prices in india", "car price list india", "car price increase", "on road price of new cars", "car prices after gst"],
  discount: ["car discounts in india", "car offers this month", "best car deals in india", "discount on new cars", "year end car offers", "car cash discount offers"],
  safety: ["bharat ncap rating", "safest cars in india", "global ncap crash test india", "5 star safety rating cars in india", "car safety features india", "airbags in cars india"],
  sales: ["best selling cars in india", "car sales in india", "top selling cars this month", "top 10 cars in india", "car sales report india", "best selling suv in india"],
  spy: ["upcoming cars in india", "spied test mule india", "new car spy shots india", "upcoming suv launch date", "test mule spotted in india", "upcoming car launches"],
  comparison: ["car comparison in india", "which car to buy in india", "best cars compared india", "car vs car comparison", "best suv to buy in india", "car buying guide india"],
  news: ["car news india", "latest car news", "new car news in india", "auto news india", "latest car launches india", "new car updates"],
};

const CAR_TEMPLATES = {
  launch: (n, full) => [`${full} launch date in india`, `${n} expected price`, `${n} features`, `${n} rivals`, `${n} launch date`, `when will ${n} launch in india`],
  pricing: (n, full) => [`${full} price in india`, `${n} new price list`, `${n} price hike`, `${n} on road price`, `${n} variants`, `${n} ex showroom price`],
  discount: (n, full) => [`${n} discount`, `${n} offers this month`, `${full} on road price`, `${n} variants`, `${n} emi`],
  safety: (n, full) => [`${full} safety rating`, `${n} ncap rating`, `is ${n} safe`, `${n} airbags`, `${n} features`],
  sales: (n, full) => [`${full} sales`, `${n} sales figures`, `${n} monthly sales`, `${n} price`, `${n} rivals`],
  spy: (n, full) => [`new ${full}`, `${n} spied`, `${n} launch date`, `${n} expected price`, `${n} features`],
  comparison: (n) => [`${n} comparison`, `${n} vs rivals`, `which is better ${n}`, `${n} price`, `${n} features`],
  news: (n, full) => [full, `${n} price`, `${n} features`, `${n} variants`, `${n} mileage`, `${n} on road price`],
};

const WEIGHT = { high: 3, medium: 2, "long-tail": 1 };
const clean = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * @param {{title: string, summary?: string, category: string, published?: string | Date | null, car?: {name: string, brand: string} | null, seedPrimary?: string, seedSecondary?: string[]}} o
 * @returns {Promise<{primary: string, secondary: string[], candidates: string[]}>}
 */
export async function newsKeywordPlan({ title, summary = "", category, published = null, car = null, seedPrimary = "", seedSecondary = [] }) {
  const text = clean(`${title} ${summary}`);
  const out = [];
  const add = (phrase, score) => {
    const p = clean(phrase);
    if (p.length >= 6 && p.split(" ").length <= 8 && !out.some((x) => x.phrase === p)) out.push({ phrase: p, score });
  };

  // 1. The keyword bank: phrases found in the story's own words, strongest first.
  const bank = await rows("SELECT phrase, priority, volume FROM keywords");
  for (const k of bank) {
    const phrase = clean(k.phrase);
    if (phrase.length >= 6 && text.includes(phrase)) add(phrase, 100 + (WEIGHT[k.priority] ?? 1) * 10 + Math.log10((k.volume ?? 0) + 1) * 10);
  }

  // 2. The car the story is about.
  if (car) {
    const n = clean(car.name);
    const full = clean(`${car.brand} ${car.name}`);
    if (seedPrimary) add(seedPrimary, 90);
    (CAR_TEMPLATES[category] ?? CAR_TEMPLATES.news)(n, full).forEach((p, i) => add(p, 80 - i * 3));
    for (const s of seedSecondary) add(s, 60);
  }

  // 3. A brand and a body style named in the headline.
  const brands = (await rows("SELECT name FROM brands")).map((b) => clean(b.name));
  const brand = brands.filter((b) => text.includes(b)).sort((a, b) => b.length - a.length)[0];
  const body = BODY.find(([re]) => re.test(title))?.[1];
  const lifecycle = /\b(upcoming|unveil|launch|debut|reveal|expected)\w*/i.test(title);
  if (brand && body && !car) add(lifecycle ? `upcoming ${brand} ${body}s in india` : `${brand} ${body}s in india`, 70);
  if (body && !car) {
    add(lifecycle ? `upcoming ${body}s in india` : `best ${body}s in india`, 66);
    add(lifecycle ? `new ${body} launches` : `${body} price in india`, 55);
  }
  if (brand && !car) {
    add(lifecycle ? `upcoming ${brand} cars` : `${brand} cars in india`, 64);
    add(`${brand} new car launches`, 52);
    add(`${brand} car price`, 48);
  }

  // 4. The kind of story, with the month it happened in (people search "new car launches december 2026").
  const when = new Date(published || Date.now());
  const month = when.toLocaleString("en-IN", { month: "long", timeZone: "Asia/Kolkata" }).toLowerCase();
  const year = when.getFullYear();
  const MONTHLY = { launch: ["new car launches", "upcoming cars"], pricing: ["car price hike"], discount: ["car discounts", "car offers"], sales: ["car sales", "best selling cars"], safety: ["ncap rating cars"], spy: ["upcoming cars"], comparison: ["best cars to buy"], news: ["car news"] };
  (MONTHLY[category] ?? MONTHLY.news).forEach((p, i) => add(`${p} ${month} ${year}`, 58 - i * 2));
  (CATEGORY_PHRASES[category] ?? CATEGORY_PHRASES.news).forEach((p, i) => add(p, 40 - i * 4));

  // A main keyword any other article already targets is not reused, so two pages never compete for one search.
  const used = new Set((await rows("SELECT keywords->>0 AS k FROM articles WHERE jsonb_typeof(keywords) = 'array' AND jsonb_array_length(keywords) > 0")).map((r) => clean(r.k)));
  const ranked = out.sort((a, b) => b.score - a.score).map((x) => x.phrase);
  const fresh = ranked.filter((p) => !used.has(p));
  // A long phrase repeated even twice trips the stuffing limit, so the main keyword is at most five words.
  const wordsIn = (p) => p.split(" ").length;
  // When every candidate is taken, the month makes it a phrase of its own ("toyota fortuner launch november 2026").
  const dated = ranked.map((p) => `${p} ${month} ${year}`).find((p) => !used.has(p) && wordsIn(p) <= 6);
  const primary = fresh.find((p) => wordsIn(p) <= 5) ?? fresh.find((p) => wordsIn(p) <= 6) ?? dated ?? `car news ${month} ${year}`;
  const secondary = ranked.filter((p) => p !== primary && wordsIn(p) <= 6).slice(0, 9);
  return { primary, secondary, candidates: ranked };
}
