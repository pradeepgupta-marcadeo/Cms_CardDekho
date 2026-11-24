// Every indexable URL on the website, built from the same snapshot the website
// reads. Mirrors the website's sitemap.ts.
const STATIC = ["", "/new-cars", "/popular-cars", "/electric-cars", "/upcoming-cars", "/latest-cars", "/brands", "/compare-cars", "/car-offers", "/fuel-prices", "/news", "/expert-reviews", "/tips-advice", "/user-reviews", "/write-review", "/car-collections", "/visual-stories", "/car-loan", "/emi-calculator", "/car-insurance", "/about", "/careers", "/contact", "/faqs", "/feedback", "/advertise", "/partner-dealer", "/privacy-policy", "/terms", "/image-credits", "/shortlist"];
export const CAR_TABS = ["price", "specs", "images", "colours", "mileage", "reviews", "offers", "emi", "dealers", "news", "faqs", "variants"];

export function sitePaths(snap) {
  const out = STATIC.map((p) => ({ path: p || "/", group: "Main pages" }));
  for (const f of Object.keys(snap.facets)) out.push({ path: `/new-cars/${f}`, group: "Car lists" });
  for (const b of snap.brands) if (snap.cars.some((c) => c.brandSlug === b.slug)) out.push({ path: `/brands/${b.slug}`, group: "Brands" });
  for (const c of snap.cars) {
    const base = `/cars/${c.brandSlug}/${c.slug}`;
    out.push({ path: base, group: "Car pages", car: c.full });
    for (const t of CAR_TABS) out.push({ path: `${base}/${t}`, group: "Car tabs", car: c.full });
  }
  for (const a of snap.articles) out.push({ path: `${a.kind === "news" ? "/news" : a.kind === "review" ? "/expert-reviews" : "/tips-advice"}/${a.slug}`, group: "Articles" });
  for (const t of Object.keys(snap.topics)) out.push({ path: `/news/topic/${t}`, group: "News topics" });
  for (const c of snap.collections) out.push({ path: `/car-collections/${c.slug}`, group: "Car lists" });
  for (const s of snap.stories) out.push({ path: `/visual-stories/${s.slug}`, group: "Car lists" });
  for (const [a, b] of snap.comparePairs) out.push({ path: `/compare-cars/${a}-vs-${b}`, group: "Comparisons" });
  return out;
}

// Reads what the live page currently shows, so editors see the real title and text.
export function readPage(html) {
  const pick = (re) => html.match(re)?.[1]?.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').trim() ?? "";
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "");
  const main = body.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? body;
  const headings = [...main.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({ level: Number(m[1]), text: m[2].replace(/<[^>]+>/g, "").trim() }));
  const paras = [...main.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).filter((p) => p.length > 30);
  return {
    title: pick(/<title[^>]*>([^<]*)<\/title>/i),
    description: pick(/<meta name="description" content="([^"]*)"/i),
    canonical: pick(/<link rel="canonical" href="([^"]*)"/i),
    image: pick(/<meta property="og:image" content="([^"]*)"/i),
    robots: pick(/<meta name="robots" content="([^"]*)"/i),
    h1: headings.find((h) => h.level === 1)?.text ?? "",
    sections: [{ h: headings.find((h) => h.level === 2)?.text ?? "", p: paras }],
    headings: headings.filter((h) => h.level > 1).map((h) => h.text).slice(0, 30),
  };
}
