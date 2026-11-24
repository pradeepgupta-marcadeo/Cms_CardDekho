// Builds a keyword bank for free, from the patterns people use to search for cars
// in India ("creta price in pune", "nexon vs brezza"). Search volume is unknown
// without a paid tool, so each phrase gets a priority instead: "high" for the
// head terms every car portal ranks for, "medium" for common modifiers, and
// "long-tail" for specific phrases that are easier to rank for.

export const carUrl = (c) => `/cars/${c.brandSlug}/${c.slug}`;

/** "Urban Cruiser Hyryder" + "Hyryder G" -> "urban cruiser hyryder g": no word repeated where the names meet. */
export function joinNames(name, variant) {
  const a = name.toLowerCase().split(" ");
  const b = variant.toLowerCase().split(" ");
  for (let n = Math.min(a.length, b.length); n > 0; n--) if (a.slice(-n).join(" ") === b.slice(0, n).join(" ")) return [...a, ...b.slice(n)].join(" ");
  return `${a.join(" ")} ${b.join(" ")}`;
}

/**
 * Every phrase people search for one car, each aimed at the one page that answers it (so pages never compete):
 * head terms ("creta price"), common modifiers ("creta on road price", "creta top model price") and long-tail
 * phrases ("creta sx o price", "creta waiting period", "creta on road price in pune").
 * @param {{brand:string, brandSlug:string, name:string, slug:string, status:string, fuels:string[], auto:boolean}} car
 * @param {{cities?: {name:string, slug:string}[], rivals?: {name:string, pairSlug:string}[], variants?: {name:string, slug:string}[], year?: number}} more
 */
export function carKeywords(car, { cities = [], rivals = [], variants = [], year = new Date().getFullYear() } = {}) {
  const n = car.name.toLowerCase();
  const full = `${car.brand} ${car.name}`.toLowerCase();
  const base = carUrl(car);
  const out = [];
  const seen = new Set();
  const k = (phrase, priority, intent, path) => {
    const p = phrase.replace(/\s+/g, " ").trim();
    if (!seen.has(p)) out.push({ phrase: p, priority, intent, target_path: path });
    seen.add(p);
  };
  const upcoming = car.status === "upcoming";
  const ev = car.fuels.length === 1 && car.fuels[0] === "Electric";
  const fuels = car.fuels.map((f) => f.toLowerCase()).filter((f) => f !== "electric");

  // Overview: the car's name and its "everything" searches.
  k(full, "high", "navigational", base);
  k(n, "high", "navigational", base);
  k(`${n} car`, "medium", "navigational", base);
  k(`${full} ${year}`, "medium", "informational", base);
  k(`${n} review`, "high", "commercial", base);
  k(`${n} pros and cons`, "long-tail", "commercial", base);
  k(`${n} waiting period`, "long-tail", "transactional", base);
  if (upcoming) {
    k(`${n} launch date`, "high", "informational", base);
    k(`${n} expected price`, "high", "commercial", base);
    k(`${n} launch date in india`, "medium", "informational", base);
    k(`upcoming ${full}`, "long-tail", "informational", base);
  }

  // Price.
  k(`${n} price`, "high", "commercial", `${base}/price`);
  k(`${n} on road price`, "high", "commercial", `${base}/price`);
  k(`${n} price in india`, "high", "commercial", `${base}/price`);
  k(`${full} price in india`, "medium", "commercial", `${base}/price`);
  k(`${full} on road price`, "medium", "commercial", `${base}/price`);
  k(`${n} price ${year}`, "medium", "commercial", `${base}/price`);
  k(`${n} ex showroom price`, "long-tail", "commercial", `${base}/price`);
  k(`${n} road tax`, "long-tail", "commercial", `${base}/price`);
  if (car.fuels.length > 1) for (const f of fuels) k(`${n} ${f} price`, "long-tail", "commercial", `${base}/price`);
  if (ev) k(`${n} ev price`, "medium", "commercial", `${base}/price`);
  for (const city of cities) {
    const c = city.name.toLowerCase();
    k(`${n} on road price in ${c}`, "long-tail", "commercial", `${base}/price-in-${city.slug}`);
    k(`${n} price in ${c}`, "long-tail", "commercial", `${base}/price-in-${city.slug}`);
  }

  // Variants: the range, then every single trim.
  k(`${n} variants`, "high", "commercial", `${base}/variants`);
  k(`${n} top model price`, "high", "commercial", `${base}/variants`);
  k(`${n} base model price`, "high", "commercial", `${base}/variants`);
  k(`${n} top model`, "medium", "commercial", `${base}/variants`);
  k(`${n} base model`, "medium", "commercial", `${base}/variants`);
  k(`${n} variants explained`, "long-tail", "informational", `${base}/variants`);
  k(`${n} which variant to buy`, "long-tail", "commercial", `${base}/variants`);
  if (car.auto) {
    k(`${n} automatic price`, "medium", "commercial", `${base}/variants`);
    k(`${n} automatic`, "medium", "commercial", `${base}/variants`);
  }
  for (const v of variants) {
    const name = joinNames(n, v.name);
    k(`${name} price`, "long-tail", "commercial", `${base}/variants/${v.slug}`);
    k(`${name} features`, "long-tail", "informational", `${base}/variants/${v.slug}`);
  }

  // Specifications and features.
  k(`${n} specifications`, "high", "informational", `${base}/specs`);
  k(`${n} features`, "high", "informational", `${base}/specs`);
  k(`${n} specs`, "medium", "informational", `${base}/specs`);
  k(`${n} dimensions`, "medium", "informational", `${base}/specs`);
  k(`${n} boot space`, "medium", "informational", `${base}/specs`);
  k(`${n} ground clearance`, "long-tail", "informational", `${base}/specs`);
  k(`${n} length`, "long-tail", "informational", `${base}/specs`);
  k(`${n} seating capacity`, "long-tail", "informational", `${base}/specs`);
  k(`${n} safety rating`, "medium", "informational", `${base}/specs`);
  k(`${n} airbags`, "long-tail", "informational", `${base}/specs`);
  k(`${n} sunroof`, "long-tail", "informational", `${base}/specs`);
  k(`${n} engine`, "long-tail", "informational", `${base}/specs`);
  if (!ev) k(`${n} fuel tank capacity`, "long-tail", "informational", `${base}/specs`);
  if (ev) {
    k(`${n} battery`, "medium", "informational", `${base}/specs`);
    k(`${n} charging time`, "medium", "informational", `${base}/specs`);
  }

  // Mileage or range (the mileage page exists only once a figure is listed).
  if (car.hasMileage !== false) {
    if (ev) {
      k(`${n} range`, "high", "informational", `${base}/mileage`);
      k(`${n} real world range`, "long-tail", "informational", `${base}/mileage`);
      k(`${n} range per charge`, "long-tail", "informational", `${base}/mileage`);
    } else {
      k(`${n} mileage`, "high", "informational", `${base}/mileage`);
      k(`${n} real world mileage`, "long-tail", "informational", `${base}/mileage`);
      k(`${n} mileage per litre`, "long-tail", "informational", `${base}/mileage`);
      if (car.fuels.length > 1) for (const f of fuels) k(`${n} ${f} mileage`, "long-tail", "informational", `${base}/mileage`);
    }
  }

  // Photos and colours.
  k(`${n} images`, "high", "informational", `${base}/images`);
  k(`${n} interior`, "medium", "informational", `${base}/images`);
  k(`${n} photos`, "medium", "informational", `${base}/images`);
  k(`${n} interior images`, "long-tail", "informational", `${base}/images`);
  k(`${n} colours`, "high", "informational", `${base}/colours`);
  k(`${n} colors`, "medium", "informational", `${base}/colours`);
  k(`${n} colour options`, "long-tail", "informational", `${base}/colours`);

  // Ownership: reviews, EMI, dealers, news, questions.
  k(`${n} owner review`, "medium", "commercial", `${base}/reviews`);
  k(`${n} user reviews`, "long-tail", "commercial", `${base}/reviews`);
  k(`${n} problems`, "long-tail", "informational", `${base}/reviews`);
  k(`${n} emi`, "high", "transactional", `${base}/emi`);
  k(`${n} emi per month`, "medium", "transactional", `${base}/emi`);
  k(`${n} down payment`, "medium", "transactional", `${base}/emi`);
  k(`${n} car loan`, "long-tail", "transactional", `${base}/emi`);
  k(`${n} showroom`, "medium", "transactional", `${base}/dealers`);
  k(`${n} dealers near me`, "medium", "transactional", `${base}/dealers`);
  k(`${n} news`, "medium", "informational", `${base}/news`);
  k(`${n} latest news`, "long-tail", "informational", `${base}/news`);
  k(`${n} facelift`, "long-tail", "informational", `${base}/news`);
  k(`${n} faq`, "long-tail", "informational", `${base}/faqs`);
  k(`${n} questions`, "long-tail", "informational", `${base}/faqs`);

  // Comparisons with the rivals the site compares it with.
  for (const r of rivals) k(`${n} vs ${r.name.toLowerCase()}`, "medium", "commercial", `/compare-cars/${r.pairSlug}`);
  return out;
}

export function siteKeywords(cities = []) {
  const k = (phrase, priority, intent, target_path) => ({ phrase, priority, intent, target_path });
  return [
    k("new cars", "high", "commercial", "/new-cars"),
    k("new cars in india", "high", "commercial", "/new-cars"),
    k("car price in india", "high", "commercial", "/new-cars"),
    k("best suv in india", "high", "commercial", "/new-cars/suv"),
    k("suv cars", "high", "commercial", "/new-cars/suv"),
    k("best hatchback cars", "medium", "commercial", "/new-cars/hatchback"),
    k("best sedan cars in india", "medium", "commercial", "/new-cars/sedan"),
    k("7 seater cars in india", "high", "commercial", "/new-cars/muv"),
    k("luxury cars in india", "medium", "commercial", "/new-cars/luxury"),
    k("cars under 10 lakh", "high", "commercial", "/new-cars/under-10-lakh"),
    k("best cars under 10 lakh", "high", "commercial", "/new-cars/under-10-lakh"),
    k("cars under 15 lakh", "high", "commercial", "/new-cars/under-15-lakh"),
    k("best suv under 15 lakh", "medium", "commercial", "/new-cars/under-15-lakh"),
    k("cars under 25 lakh", "medium", "commercial", "/new-cars/under-25-lakh"),
    k("cars above 25 lakh", "long-tail", "commercial", "/new-cars/above-25-lakh"),
    k("automatic cars under 10 lakh", "long-tail", "commercial", "/new-cars/under-10-lakh"),
    k("electric cars in india", "high", "commercial", "/electric-cars"),
    k("best electric car in india", "medium", "commercial", "/electric-cars"),
    k("electric car price", "medium", "commercial", "/electric-cars"),
    k("upcoming cars in india", "high", "informational", "/upcoming-cars"),
    k("upcoming cars 2026", "high", "informational", "/upcoming-cars"),
    k("new car launches", "high", "informational", "/latest-cars"),
    k("latest cars in india", "medium", "informational", "/latest-cars"),
    k("popular cars in india", "medium", "commercial", "/popular-cars"),
    k("compare cars", "high", "commercial", "/compare-cars"),
    k("car comparison", "medium", "commercial", "/compare-cars"),
    k("car brands in india", "medium", "navigational", "/brands"),
    k("petrol price today", "high", "informational", "/fuel-prices"),
    k("diesel price today", "high", "informational", "/fuel-prices"),
    k("cng price today", "medium", "informational", "/fuel-prices"),
    k("car loan emi calculator", "high", "transactional", "/emi-calculator"),
    k("car loan interest rate", "medium", "transactional", "/car-loan"),
    k("car insurance", "high", "transactional", "/car-insurance"),
    k("car news", "high", "informational", "/news"),
    k("car news india", "medium", "informational", "/news"),
    k("car reviews", "medium", "informational", "/expert-reviews"),
    k("car buying tips", "medium", "informational", "/tips-advice"),
    k("best mileage cars in india", "medium", "commercial", "/new-cars"),
    k("best cng cars in india", "medium", "commercial", "/new-cars"),
    k("safest cars in india", "medium", "commercial", "/car-collections/safest-cars-in-india"),
    k("best first car in india", "long-tail", "commercial", "/car-collections/best-first-cars"),
    ...cities.flatMap((c) => [
      k(`petrol price in ${c.name.toLowerCase()}`, "medium", "informational", "/fuel-prices"),
    ]),
  ];
}

// Picks the keywords an editor should aim at for a page: the first high-priority
// phrase becomes the main keyword, the rest become secondary keywords.
export function pickForPath(all, path) {
  const order = { high: 0, medium: 1, "long-tail": 2 };
  const list = all.filter((k) => k.target_path === path).sort((a, b) => order[a.priority] - order[b.priority]);
  return { primary: list[0]?.phrase ?? "", secondary: list.slice(1, 12).map((k) => k.phrase) };
}
