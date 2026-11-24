// Turns facts into saved drafts: news from a lead, an expert review or a tips
// article from a brief, and a car page's buying-guide copy. Drafts are never
// published automatically.
import { one, query, rows } from "../db.js";
import { readStoryFacts } from "../importers/news.js";
import { writeArticle, writeCarCopy } from "./ai-writer.js";
import { fixDraft, nameFixer } from "./casing.js";
import { pickAuthor } from "./authors.js";
import { backfillArticles } from "./autofill.js";
import { flattenSections } from "./text.js";
import { pageImage, storeStoryImage } from "./news-image.js";
import { sectionsToHtml } from "./rich.js";
import { newsKeywordPlan } from "./news-keywords.js";
import { OVERLAP_LIMIT, overlapPercent, sameHeadline, sameStory, sameText } from "./news-text.js";
import { carUrl, pickForPath } from "./keywords.js";
import { audit, contentChanged } from "./publish.js";

export async function carFacts(carId) {
  const car = await one("SELECT c.*, b.name AS brand, b.slug AS brand_slug FROM cars c JOIN brands b ON b.id = c.brand_id WHERE c.id = $1", [carId]);
  if (!car) return null;
  const variants = await rows("SELECT name, fuel, trans, price, highlights FROM variants WHERE car_id = $1 ORDER BY price", [carId]);
  const lines = [
    `Car: ${car.brand} ${car.name} (${car.body}, ${car.seats} seats, status: ${car.status}${car.launch ? `, launch: ${car.launch}` : ""})`,
    car.min_price ? `Ex-showroom price: Rs ${car.min_price} lakh to Rs ${car.max_price} lakh (Delhi)` : "Price: not announced",
    `Fuels: ${car.fuels.join(", ")}; automatic available: ${car.auto ? "yes" : "no"}`,
    car.engine ? `Engine/battery: ${car.engine}; power up to ${car.power}; torque up to ${car.torque}` : "",
    car.mileage ? `Claimed efficiency or range: ${car.mileage}` : "",
    car.boot ? `Boot space: ${car.boot} litres` : "",
    car.dims?.length ? `Dimensions: length ${car.dims.length} mm, width ${car.dims.width} mm, height ${car.dims.height} mm, wheelbase ${car.dims.wheelbase} mm${car.dims.tank ? `, fuel tank ${car.dims.tank} litres` : ""}` : "",
    car.ncap ? `Crash test rating in our catalogue: ${car.ncap} star` : "",
    car.features?.top ? `Top trim (${car.features.topTrim}) features: ${Object.entries(car.features.top).filter(([, v]) => v && v !== "none").map(([k, v]) => (v === true ? k : `${k}: ${v}`)).join(", ")}` : "",
    car.features?.base ? `Base trim (${car.features.baseTrim}) features: ${Object.entries(car.features.base).filter(([, v]) => v && v !== "none").map(([k, v]) => (v === true ? k : `${k}: ${v}`)).join(", ")}` : "",
    variants.length ? `Variants (${variants.length}): ${variants.slice(0, 30).map((v) => `${v.name} Rs ${v.price} lakh`).join("; ")}` : "",
    car.pros?.length ? `Known strengths: ${car.pros.join("; ")}` : "",
    car.cons?.length ? `Known weak points: ${car.cons.join("; ")}` : "",
  ];
  return { car, text: lines.filter(Boolean).join("\n") };
}

async function keywordsFor(path) {
  const all = await rows("SELECT phrase, priority, target_path FROM keywords WHERE target_path = $1 OR target_path LIKE $2", [path, `${path}/%`]);
  return all;
}

async function uniqueSlug(kind, base) {
  let slug = base || `story-${Date.now()}`;
  for (let i = 2; await one("SELECT 1 FROM articles WHERE kind = $1 AND slug = $2", [kind, slug]); i++) slug = `${base}-${i}`;
  return slug;
}

export async function saveDraft(req, kind, raw, extra) {
  const draft = fixDraft(await nameFixer(), raw);
  const slug = await uniqueSlug(kind, draft.slug);
  const a = await one(
    `INSERT INTO articles (kind, slug, title, excerpt, category, author, minutes, car_id, rival_id, photo_car_id, body, keywords, seo, source, status, ai_generated, published_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,$16) RETURNING id`,
    [kind, slug, draft.title, draft.excerpt, extra.category ?? draft.category ?? "news", extra.author ?? "Wheelora Desk", Math.max(3, Math.round(draft.words / 200)), extra.carId ?? null, extra.rivalId ?? null, extra.carId ?? null, JSON.stringify(flattenSections(draft.sections)), JSON.stringify(draft.keywords), JSON.stringify({ title: draft.seoTitle, description: draft.seoDescription, faqs: draft.faqs, score: draft.seo.score, ai: `${draft.provider} ${draft.model}` }), extra.source ? JSON.stringify(extra.source) : null, extra.status === "published" ? "published" : "draft", extra.date ?? new Date().toISOString().slice(0, 10)],
  );
  // The byline is shared out among the active authors; the body is also kept as HTML for the rich-text editor.
  const author = extra.author ? { id: null, name: extra.author } : await pickAuthor();
  await query("UPDATE articles SET author = $2, author_id = $3, body_html = $4, tags = $5 WHERE id = $1", [a.id, author.name, author.id, sectionsToHtml(draft.sections), (draft.keywords ?? []).slice(1, 9)]);
  await audit(req, "ai-draft", "articles", a.id, `${draft.provider} ${draft.model}: ${draft.title}`);
  return a.id;
}

const plain = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * An existing article the new draft would duplicate, as "/slug (why)", or null. Checked against every article,
 * draft or published: same heading or search title, the same story (car + kind + date), an identical
 * description or summary, or body text that repeats it.
 */
export async function findTwin({ draft, carId, category, date }) {
  const all = await rows(`SELECT id, slug, title, excerpt, seo->>'title' AS seo_title, seo->>'description' AS seo_desc, body_html, car_id, category, COALESCE(published_on, created_at::date) AS day FROM articles`);
  const text = draft.sections.flatMap((s) => [s.h, ...(s.p ?? []), ...(s.bullets ?? [])]).join(" ");
  for (const a of all) {
    const headings = [a.title, a.seo_title].filter(Boolean);
    const mine = [draft.title, draft.seoTitle].filter(Boolean);
    if (mine.some((m) => headings.some((h) => plain(h) === plain(m) || sameHeadline(m, h)))) return `/${a.slug} (same headline)`;
    if (sameStory({ title: draft.title, carId, category, date }, { title: a.title, carId: a.car_id, category: a.category, date: a.day })) return `/${a.slug} (same story)`;
    if (draft.seoDescription && plain(draft.seoDescription) === plain(a.seo_desc)) return `/${a.slug} (same description)`;
    if (draft.excerpt && plain(draft.excerpt) === plain(a.excerpt)) return `/${a.slug} (same summary)`;
    if (a.body_html && (carId ? a.car_id === carId : a.category === category) && sameText(text, a.body_html)) return `/${a.slug} (repeats its text)`;
  }
  return null;
}

export const CATEGORY = (title) => (/launch|unveil|debut|introduced/i.test(title) ? "launch" : /price|cost/i.test(title) ? "pricing" : /discount|offer/i.test(title) ? "discount" : /ncap|crash|safety/i.test(title) ? "safety" : /sales|sold|units/i.test(title) ? "sales" : /spied|spotted|teaser|teased/i.test(title) ? "spy" : /\bvs\b|compar/i.test(title) ? "comparison" : "news");

/**
 * Writes an original news draft from a lead.
 * opts.sources: other leads carrying the same story (their pages are read too).
 * opts.publish: publish it if it passes the length check (the scheduler's mode); the button leaves a draft.
 * opts.log: gets one line per step. opts.out: filled with { words, thin, overlap }.
 */
export async function draftFromLead(req, leadId, opts = {}) {
  const log = opts.log ?? (() => {});
  const lead = await one("SELECT * FROM news_leads WHERE id = $1", [leadId]);
  if (!lead) throw new Error("Lead not found.");
  if (lead.article_id) return lead.article_id;
  const members = [lead, ...(opts.sources ?? [])];
  // The picture comes first: a story without a photograph of its own is not worth an AI call.
  // The story page's own social image is tried before the picture the feed offered.
  const cleanName = (name) => name.replace(/ \(via GDELT\)$/, "");
  const why = [];
  let picture = null;
  for (const [i, m] of members.entries()) {
    const found = await storeStoryImage({ candidates: [i === 0 ? await pageImage(m.url) : null, m.image_url], title: lead.title, credit: cleanName(m.source), why });
    if (found) {
      picture = found;
      break;
    }
  }
  if (!picture) throw Object.assign(new Error(`no picture of its own at the source${why[0] ? ` (${why[0]})` : ""}`), { code: "NO_IMAGE" });
  log(`Fetching  picture ${picture.w}x${picture.h} from ${picture.credit}`);
  const pages = [];
  for (const [i, m] of members.entries()) {
    if (i) await new Promise((r) => setTimeout(r, 1500));
    const got = await readStoryFacts(m.url).catch((err) => ({ text: "", note: err.message }));
    if (got.text) {
      pages.push({ source: m.source, text: got.text });
      log(`Fetching  ${got.text.length} chars from ${m.source}`);
    } else log(`Fetching  ${m.source} gave nothing (${got.note || "no readable story"})`);
  }
  if (members.length > 1 && pages.length > 1) log(`Using  ${pages.length} sources: ${pages.map((p) => p.source).join(", ")}`);
  const story = { text: pages.map((p) => `--- as reported by ${p.source} ---\n${p.text}`).join("\n\n") };
  let carInfo = lead.car_id ? await carFacts(lead.car_id) : null;
  // A car named only as a rival ("Honda SUVs ... rival to Creta") is not the story's subject:
  // if another brand is named earlier in the headline, the car's data and keywords are left out.
  if (carInfo) {
    const t = lead.title.toLowerCase();
    const spot = (name) => Math.min(...[name, name.replace(/ /g, "-"), name.replace(/ /g, "")].map((v) => t.indexOf(v)).filter((i) => i >= 0), Infinity);
    const at = spot(carInfo.car.name.toLowerCase());
    const earlier = (await rows("SELECT name FROM brands")).some((b) => b.name.toLowerCase() !== carInfo.car.brand.toLowerCase() && spot(b.name.toLowerCase()) < at);
    if (earlier) carInfo = null;
  }
  const subjectCarId = carInfo ? lead.car_id : null;
  const category = CATEGORY(lead.title);
  let primary = "";
  let secondary = [];
  if (carInfo) {
    const name = carInfo.car.name.toLowerCase();
    const full = `${carInfo.car.brand} ${carInfo.car.name}`.toLowerCase();
    // The phrase people would actually search for this kind of story.
    primary = { launch: `${full} launch`, pricing: `${name} price`, discount: `${name} discount`, safety: `${name} safety rating`, sales: `${full} sales`, spy: `new ${full}`, comparison: `${name} comparison` }[category] ?? full;
    const kw = pickForPath(await keywordsFor(carUrl({ brandSlug: carInfo.car.brand_slug, slug: carInfo.car.slug })), carUrl({ brandSlug: carInfo.car.brand_slug, slug: carInfo.car.slug }));
    secondary = [kw.primary, `${name} on road price`, `${name} variants`, `${name} features`, `${name} mileage`].filter(Boolean);
  }
  // Every story targets a real search phrase: car and brand phrases, body styles, and the keyword bank.
  const plan = await newsKeywordPlan({ title: lead.title, summary: lead.summary, category, published: lead.published_at, car: carInfo ? { name: carInfo.car.name, brand: carInfo.car.brand } : null, seedPrimary: primary, seedSecondary: secondary });
  primary = plan.primary;
  secondary = plan.secondary;
  log(`Targeting  "${primary}" + ${secondary.length} related phrases`);
  const facts = [
    `Headline of the original report (do not reuse its wording): ${lead.title}`,
    `Reported by: ${lead.source}${lead.published_at ? ` on ${new Date(lead.published_at).toDateString()}` : ""}`,
    lead.summary ? `Feed summary: ${lead.summary}` : "",
    story.text ? `Facts from the report:\n${story.text}` : "",
    carInfo ? `\nCatalogue data for the car (use for context; prefer the report for anything new):\n${carInfo.text}` : "",
  ].filter(Boolean).join("\n");
  const write = (factsText, extra) =>
    writeArticle({
      kind: "news article for Indian car buyers that explains what happened and what it means for someone planning to buy",
      facts: factsText,
      primary,
      secondary,
      minWords: 450,
      minSecondary: 5,
      extra: `Mention the original publication once by name in the text as the source of the report. ${extra}`.trim(),
    });
  log("Writing  asking the AI for an original article");
  let draft = await write(facts, "");
  // The draft is research, not a copy: more than 2.5% of 8-word runs shared with the source means rewrite.
  let overlap = story.text ? overlapPercent(draft.sections.flatMap((s) => [s.h, ...s.p]).join(" "), story.text) : 0;
  if (overlap > OVERLAP_LIMIT) {
    log(`Cleaned  ${overlap.toFixed(1)}% of it came from the source - writing again`);
    draft = await write(facts, "Your last attempt reused too much of the source's wording. Use none of its sentences; never more than five words in a row.");
    overlap = overlapPercent(draft.sections.flatMap((s) => [s.h, ...s.p]).join(" "), story.text);
    if (overlap > OVERLAP_LIMIT) {
      log(`Cleaned  still ${overlap.toFixed(1)}% - writing from the summary only`);
      draft = await write(facts.replace(/Facts from the report:[\s\S]*?(?=\n\nCatalogue data|$)/, ""), "");
      overlap = 0;
    }
  }
  // Last check before saving: the finished article must not repeat one we already hold, in its heading,
  // its search title or description, or its text.
  const twin = await findTwin({ draft, carId: subjectCarId, category, date: lead.published_at ?? new Date() });
  if (twin) throw Object.assign(new Error(`we already have this story: ${twin}`), { code: "DUPLICATE" });
  const thin = draft.words < 450;
  if (thin) log(`Writing  only ${draft.words} words - kept as a draft`);
  const status = opts.publish && !thin ? "published" : "draft";
  const id = await saveDraft(req, "news", draft, { carId: subjectCarId, category, status, date: lead.published_at ? new Date(lead.published_at).toISOString().slice(0, 10) : undefined, source: { name: members.map((m) => m.source.replace(/ \(via GDELT\)$/, "")).join(" + "), url: lead.url } });
  await query("UPDATE articles SET image_src = $2, image_w = $3, image_h = $4, image_alt = $5, image_title = $5, image_credit = $6 WHERE id = $1", [id, picture.src, picture.w, picture.h, draft.title, picture.credit]);
  await backfillArticles(id); // banner, alt text, tags and SEO fields are filled in without anyone typing them
  await query("UPDATE news_leads SET status = 'drafted', article_id = $2 WHERE id = ANY($1)", [members.map((m) => m.id), id]);
  if (opts.out) Object.assign(opts.out, { words: draft.words, thin, overlap, status });
  return id;
}

export async function draftReview(req, carId) {
  const info = await carFacts(carId);
  if (!info) throw new Error("Car not found.");
  const base = carUrl({ brandSlug: info.car.brand_slug, slug: info.car.slug });
  const kw = pickForPath(await keywordsFor(`${base}/reviews`), `${base}/reviews`);
  const name = info.car.name.toLowerCase();
  const draft = await writeArticle({
    kind: "expert buying review that explains who the car suits, which variant to pick, strengths, weaknesses, running costs and rivals to consider. Do not claim a test drive happened; write it as a desk review based on specifications",
    facts: info.text,
    primary: kw.primary || `${name} review`,
    secondary: [...kw.secondary, `${name} price`, `${name} mileage`, `${name} variants`].slice(0, 10),
    minWords: 800,
  });
  return saveDraft(req, "review", draft, { carId, category: "expert review" });
}

export async function draftAdvice(req, { topic, primary, secondary = [] }) {
  const draft = await writeArticle({
    kind: "practical car buying or ownership guide for Indian readers",
    facts: `Topic: ${topic}\nUse general, widely accepted knowledge about buying and owning cars in India. Do not quote specific prices, rates or laws unless they are stated here.`,
    primary,
    secondary,
    minWords: 700,
  });
  return saveDraft(req, "advice", draft, { category: "guide" });
}

export async function writeCarPageCopy(req, carId) {
  const info = await carFacts(carId);
  if (!info) throw new Error("Car not found.");
  const base = carUrl({ brandSlug: info.car.brand_slug, slug: info.car.slug });
  const kw = pickForPath(await keywordsFor(base), base);
  const copy = fixDraft(await nameFixer(), await writeCarCopy({ facts: info.text, primary: kw.primary || `${info.car.brand} ${info.car.name}`.toLowerCase(), secondary: kw.secondary }));
  await one(
    "UPDATE cars SET angle = COALESCE(NULLIF($2, ''), angle), pros = CASE WHEN cardinality($3::text[]) > 0 THEN $3 ELSE pros END, cons = CASE WHEN cardinality($4::text[]) > 0 THEN $4 ELSE cons END, overview = $5, faqs = $6, updated_at = now() WHERE id = $1 RETURNING id",
    [carId, copy.angle, copy.pros, copy.cons, JSON.stringify(copy.sections), JSON.stringify(copy.faqs)],
  );
  await audit(req, "ai-copy", "cars", carId, copy.provider);
  await contentChanged();
  return copy;
}

// When a car moves from "upcoming" to launched, a news draft announcing it.
export async function draftLaunch(req, carId) {
  const info = await carFacts(carId);
  if (!info) throw new Error("Car not found.");
  const name = info.car.name.toLowerCase();
  const draft = await writeArticle({
    kind: "launch news article announcing that this car is now on sale in India, covering prices, variants, engines, key features and who should consider it",
    facts: info.text,
    primary: `${name} launched`,
    secondary: [`${name} price`, `${name} on road price`, `${name} variants`, `${name} features`, `${name} mileage`, `${info.car.brand.toLowerCase()} ${name}`],
    minWords: 500,
  });
  return saveDraft(req, "news", draft, { carId, category: "launch" });
}
