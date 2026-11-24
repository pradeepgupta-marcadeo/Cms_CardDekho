// Builds the one JSON document the website reads. Its shape mirrors the
// website's own types (src/data/store.ts there), so a field added here must be
// read there too.
import { getSetting, rows } from "../db.js";
import { fmtDate } from "./text.js";

let cache = null;
export const invalidateSnapshot = () => {
  cache = null;
};

const keyOf = (c) => `${c.brand_slug}-${c.slug}`;
const daysLeft = (iso) => Math.max(0, Math.ceil((new Date(`${iso}T23:59:59Z`).getTime() - Date.now()) / 86400000));
const ownBody = (body) => (Array.isArray(body) ? body.filter((s) => s && (s.h || (s.p ?? []).length)) : []);

/** Keywords for every page, main keyword first: high, then medium, then long-tail. */
async function keywordsByPath() {
  const list = await rows("SELECT target_path, phrase FROM keywords WHERE target_path IS NOT NULL ORDER BY target_path, CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id");
  const out = {};
  for (const k of list) (out[k.target_path] ??= []).push(k.phrase);
  return out;
}

export async function buildSnapshot() {
  // CarScrapper jobs save in their own worker process, so this process is not told directly: the content version in
  // the database (bumped on every save) says whether the cached copy is still current.
  if (cache && String(await getSetting("content_version", 0)) === cache.version) return cache;
  const [site, analytics, nav, footer, version] = await Promise.all([
    getSetting("site", {}),
    getSetting("analytics", {}),
    getSetting("nav", []),
    getSetting("footer", []),
    getSetting("content_version", 0),
  ]);
  const [cities, brands, cars, variants, photos, articles, offers, dealers, stations, fuel, reviews, topics, lists, pairs, faqs, blocks, seo, redirects] = await Promise.all([
    rows("SELECT * FROM cities ORDER BY sort, name"),
    rows("SELECT * FROM brands ORDER BY sort, name"),
    rows("SELECT c.*, b.slug AS brand_slug, b.name AS brand_name FROM cars c JOIN brands b ON b.id = c.brand_id WHERE c.published ORDER BY c.popularity DESC, c.name"),
    rows("SELECT * FROM variants ORDER BY car_id, sort, price"),
    rows("SELECT * FROM photos ORDER BY sort, id"),
    rows("SELECT * FROM articles WHERE status = 'published' AND published_on <= CURRENT_DATE ORDER BY published_on DESC, id DESC"),
    rows("SELECT * FROM offers WHERE valid_till >= CURRENT_DATE ORDER BY valid_till"),
    rows("SELECT d.*, b.name AS brand_name, ci.name AS city_name, ci.slug AS city_slug FROM dealers d LEFT JOIN brands b ON b.id = d.brand_id JOIN cities ci ON ci.id = d.city_id ORDER BY ci.sort, d.name"),
    rows("SELECT s.*, ci.name AS city_name, ci.slug AS city_slug FROM stations s JOIN cities ci ON ci.id = s.city_id ORDER BY ci.sort, s.name"),
    rows("SELECT f.*, ci.name AS city_name, ci.slug AS city_slug, ci.state FROM fuel_prices f JOIN cities ci ON ci.id = f.city_id ORDER BY ci.sort"),
    rows("SELECT * FROM owner_reviews WHERE status = 'approved' ORDER BY created_at DESC"),
    rows("SELECT * FROM topics ORDER BY sort, key"),
    rows("SELECT * FROM lists ORDER BY kind, sort, slug"),
    rows("SELECT * FROM compare_pairs ORDER BY sort, id"),
    rows("SELECT * FROM faqs ORDER BY scope, sort, id"),
    rows("SELECT key, value FROM blocks"),
    rows("SELECT * FROM seo_pages"),
    rows("SELECT * FROM redirects ORDER BY source"),
  ]);

  const carKey = new Map(cars.map((c) => [c.id, keyOf(c)]));
  const photoOf = (p) => ({ src: p.src, w: p.w, h: p.h, kind: p.kind, credit: p.credit, license: p.license, page: p.page, colour: p.colour ?? null, ...(p.title ? { title: p.title } : {}), ...(p.angle !== null && p.angle !== undefined ? { angle: p.angle } : {}), ...(p.grp ? { group: p.grp } : {}) });
  const photosByCar = new Map();
  const sitePhotos = {};
  for (const p of photos) {
    if (p.car_id) {
      if (!photosByCar.has(p.car_id)) photosByCar.set(p.car_id, []);
      photosByCar.get(p.car_id).push(photoOf(p));
    } else if (p.site_key) {
      (sitePhotos[p.site_key] ??= []).push(photoOf(p));
    }
  }
  const variantsByCar = new Map();
  for (const v of variants) {
    if (!variantsByCar.has(v.car_id)) variantsByCar.set(v.car_id, []);
    variantsByCar.get(v.car_id).push({ slug: v.slug, name: v.name, fuel: v.fuel, trans: v.trans, price: v.price, highlights: v.highlights, url: v.source_url ?? undefined, onRoad: v.on_road ?? undefined });
  }

  // A car needs at least one photo to appear: every card and page leads with one.
  // A car needs a photo (every card leads with one) and at least one colour (the car pages list them).
  // ... and at least one priced variant (car pages, FAQs and comparisons are built from them; an upcoming car
  // whose price is not announced yet waits until it is).
  // 360 views (CarWale studio spins copied into uploads/carwale360): { closed: { frames, w, h }, open: {...} } per car.
  const spinsBySlug = new Map();
  for (const sp of await rows("SELECT car_slug, kind, frames, w, h, meta FROM car_spins WHERE status = 'done' AND jsonb_array_length(frames) > 0")) {
    if (!spinsBySlug.has(sp.car_slug)) spinsBySlug.set(sp.car_slug, {});
    // interior: the six cube faces (front, right, back, left, up, down) and the starting view
    spinsBySlug.get(sp.car_slug)[sp.kind] = sp.kind === "interior" ? { faces: sp.frames, size: sp.w, start: sp.meta?.start ?? null } : { frames: sp.frames, w: sp.w, h: sp.h };
  }
  const liveCars = cars.filter((c) => photosByCar.has(c.id) && Array.isArray(c.colors) && c.colors.length > 0 && (variantsByCar.get(c.id) ?? []).some((v) => Number(v.price) > 0));
  const live = new Set(liveCars.map((c) => c.id));
  // Every article card shows a car photo: its own photo car, else its car, else any live car.
  const photoKey = (a) => {
    const pick = [a.photo_car_id, a.car_id].find((id) => id && live.has(id));
    if (pick) return carKey.get(pick);
    return liveCars.length ? keyOf(liveCars[a.id % liveCars.length]) : null;
  };

  const authorById = new Map((await rows("SELECT id, designation, bio, image FROM authors")).map((x) => [x.id, x]));

  cache = {
    version: String(version),
    generatedAt: new Date().toISOString(),
    site: { name: site.name ?? "Wheelora", tagline: site.tagline ?? "", phone: site.phone ?? "", email: site.email ?? "" },
    analytics: {
      ga4Id: analytics.ga4Id ?? "",
      clarityId: analytics.clarityId ?? "",
      gscVerification: analytics.gscVerification ?? "",
      bingVerification: analytics.bingVerification ?? "",
      firstParty: analytics.firstParty !== false,
    },
    cities: cities.map((c) => ({ slug: c.slug, name: c.name, state: c.state, rto: c.rto, ins: c.ins, taxRules: c.tax_rules ?? null, registrationFeeRs: c.tax_source?.registrationFeeRs ?? null })),
    nav,
    footer,
    brands: brands.map((b) => ({ slug: b.slug, name: b.name, logo: b.logo ?? null, description: b.description })),
    cars: liveCars.map((c) => ({
      key: keyOf(c),
      slug: c.slug,
      brand: c.brand_name,
      brandSlug: c.brand_slug,
      name: c.name,
      full: `${c.brand_name} ${c.name}`,
      body: c.body,
      status: c.status,
      fuels: c.fuels,
      auto: c.auto,
      seats: c.seats,
      min: c.min_price,
      max: c.max_price,
      mileage: c.mileage,
      engine: c.engine,
      power: c.power,
      torque: c.torque,
      boot: c.boot,
      ncap: c.ncap,
      rating: c.rating,
      reviews: c.reviews,
      popularity: c.popularity,
      launch: c.launch ?? undefined,
      angle: c.angle,
      // Our own AI copy (CarScrapper > Car pages): a short summary and a buying verdict.
      summary: c.copy?.summary || undefined,
      spin: spinsBySlug.get(c.source?.cardekhoSlug) ?? undefined,
      verdict: c.copy?.verdict || undefined,
      pros: c.pros,
      cons: c.cons,
      colors: c.colors,
      photos: photosByCar.get(c.id),
      variants: variantsByCar.get(c.id) ?? [],
      dims: c.dims ?? null,
      features: c.features ?? null,
      model3d: c.model3d ?? null,
      overview: ownBody(c.overview),
      faqs: Array.isArray(c.faqs) ? c.faqs : [],
      source: c.source ?? null,
      updatedAt: c.updated_at,
    })),
    sitePhotos,
    articles: articles
      .filter((a) => !a.car_id || live.has(a.car_id))
      .map((a) => ({
        slug: a.slug,
        kind: a.kind,
        category: a.category,
        title: a.title,
        excerpt: a.excerpt,
        author: a.author,
        date: fmtDate(a.published_on),
        isoDate: a.published_on,
        updatedAt: a.updated_at,
        minutes: a.minutes,
        car: carKey.get(a.car_id) ?? null,
        rival: a.rival_id && live.has(a.rival_id) ? carKey.get(a.rival_id) : null,
        photo: photoKey(a),
        image: a.image_src ? { src: a.image_src, w: a.image_w || 1200, h: a.image_h || 675, alt: a.image_alt || a.title, credit: a.image_credit || "" } : null,
        html: a.body_html ?? null,
        cover: a.cover_src ? { src: a.cover_src, w: a.cover_w || 1600, h: a.cover_h || 480, alt: a.cover_alt || a.title, title: a.cover_title || "", credit: a.image_credit || "" } : null,
        ogImage: a.og_src ?? null,
        tags: a.tags ?? [],
        canonical: a.canonical_url || undefined,
        noindex: a.no_index || undefined,
        featured: a.is_featured || undefined,
        breaking: a.is_breaking || undefined,
        authorRole: authorById.get(a.author_id)?.designation || undefined,
        authorBio: authorById.get(a.author_id)?.bio || undefined,
        authorImage: authorById.get(a.author_id)?.image || undefined,
        body: ownBody(a.body),
        keywords: Array.isArray(a.keywords) ? a.keywords : [],
        source: a.source ?? null,
        faqs: Array.isArray(a.seo?.faqs) ? a.seo.faqs : [],
        seoTitle: a.seo?.title || undefined,
        seoDescription: a.seo?.description || undefined,
      })),
    offers: offers.filter((o) => live.has(o.car_id)).map((o) => ({ car: carKey.get(o.car_id), amount: o.amount, type: o.type, daysLeft: daysLeft(o.valid_till) })),
    dealers: dealers.map((d) => ({ id: d.uid, name: d.name, brand: d.brand_name ?? "", city: d.city_name, citySlug: d.city_slug, address: d.address, hours: d.hours, phone: d.phone, verified: d.verified })),
    evStations: stations.filter((s) => s.kind === "ev").map((s) => ({ id: s.uid, name: s.name, city: s.city_name, citySlug: s.city_slug, connector: s.connector ?? "", power: s.power ?? 0, hours: s.hours, address: s.address })),
    fuelStations: stations.filter((s) => s.kind === "fuel").map((s) => ({ id: s.uid, name: s.name, city: s.city_name, citySlug: s.city_slug, fuels: s.fuels, hours: s.hours, address: s.address })),
    fuelPrices: fuel.map((f) => ({ city: f.city_name, slug: f.city_slug, state: f.state, petrol: f.petrol, diesel: f.diesel, cng: f.cng ?? 0, date: fmtDate(f.price_date), source: f.source })),
    ownerReviews: reviews.filter((r) => live.has(r.car_id)).map((r) => ({ id: String(r.id), car: carKey.get(r.car_id), author: r.author, rating: r.rating, title: r.title, text: r.text, date: fmtDate(r.created_at.toISOString()) })),
    topics: Object.fromEntries(topics.map((t) => [t.key, { label: t.label, navLabel: t.nav_label, h1: t.h1, intro: t.intro, guide: t.guide, ...(t.category ? { category: t.category } : {}), ...(t.fuel ? { fuel: t.fuel } : {}) }])),
    facets: Object.fromEntries(lists.filter((l) => l.kind === "facet").map((l) => [l.slug, { label: l.title, h1: l.h1, intro: l.intro, rule: l.rule }])),
    collections: lists.filter((l) => l.kind === "collection").map((l) => ({ slug: l.slug, title: l.title, blurb: l.intro, rule: l.rule, max: l.max_items })),
    stories: lists.filter((l) => l.kind === "story").map((l) => ({ slug: l.slug, title: l.title, intro: l.intro, rule: l.rule, max: l.max_items })),
    comparePairs: pairs.filter((p) => live.has(p.a_id) && live.has(p.b_id)).map((p) => [carKey.get(p.a_id), carKey.get(p.b_id)]),
    faqsHome: faqs.filter((f) => f.scope === "home").map((f) => ({ q: f.q, a: f.a })),
    blocks: Object.fromEntries(blocks.map((b) => [b.key, b.value])),
    seo: Object.fromEntries(seo.map((s) => [s.path, { title: s.title || undefined, description: s.description || undefined, noindex: s.noindex, keywords: s.keywords }])),
    // Search phrases per page, main keyword first (from the keyword bank, kept in step with the site).
    keywords: await keywordsByPath(),
    redirects: redirects.map((r) => ({ source: r.source, destination: r.destination, permanent: r.permanent })),
    // Data sources the website must credit (licence terms of each source).
    credits: [
      spinsBySlug.size > 0 && { name: "CarWale", url: "https://www.carwale.com", license: "© CarWale", what: "360 degree studio views of many cars (frames shown with CarWale's watermark)" },
      liveCars.some((c) => c.source?.name === "VariantWise") && { name: "VariantWise Open Dataset", url: "https://variantwise.com/data", license: "CC BY 4.0", what: "Prices, variants, specifications and road-tax slabs" },
      cities.some((c) => c.tax_rules) && { name: "VariantWise road-tax dataset", url: "https://variantwise.com/data", license: "CC BY 4.0", what: "State road-tax slabs used in on-road prices" },
      fuel.some((x) => /PPAC/.test(x.source)) && { name: "PPAC, Ministry of Petroleum and Natural Gas", url: "https://ppac.gov.in", license: "Government of India", what: "Daily petrol and diesel prices for metro cities" },
      (stations.some((x) => x.source === "openstreetmap") || dealers.some((x) => x.source === "openstreetmap")) && { name: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright", license: "ODbL 1.0", what: "Fuel stations, EV chargers and showroom locations" },
      stations.some((x) => x.source === "openchargemap") && { name: "Open Charge Map", url: "https://openchargemap.org", license: "CC BY 4.0", what: "EV charging stations" },
    ].filter(Boolean),
  };
  return cache;
}
