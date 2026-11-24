// Suggests a Google title, description and keywords for any page of the website, from the data the page is built
// from. Nothing is invented: it only rearranges names, categories and facts the CMS already holds.

const MAIN = {
  "/": ["New Cars in India: Prices, Reviews & Comparisons", "Find your next car on Wheelora: compare new cars, check prices and variants, read expert reviews and the latest car news in India."],
  "/new-cars": ["New Cars in India", "Browse every new car on sale in India by brand, budget, body type and fuel, with prices, mileage, variants and specifications."],
  "/popular-cars": ["Popular Cars in India", "See the most popular cars in India right now, ranked by buyer interest, with prices, mileage and variants to compare."],
  "/electric-cars": ["Electric Cars in India", "Compare electric cars in India with price, claimed range, charging time and features to find the right EV for your budget."],
  "/upcoming-cars": ["Upcoming Cars in India", "Track upcoming cars in India with expected launch dates and prices, so you know what is coming before you buy."],
  "/latest-cars": ["Latest Cars in India", "See the latest cars launched in India with their prices, variants, mileage and key features in one place."],
  "/brands": ["Car Brands in India", "Explore all car brands sold in India and see each brand's models, prices and specifications."],
  "/compare-cars": ["Compare Cars Side by Side", "Compare two or more cars side by side on price, mileage, engine, features and safety to pick the better buy."],
  "/car-offers": ["Car Offers and Discounts in India", "Check current car offers, discounts and benefits in India and see what you can save on your next new car."],
  "/fuel-prices": ["Petrol and Diesel Prices Today", "Check today's petrol, diesel and CNG prices in major Indian cities, updated daily from official sources."],
  "/news": ["Car News India", "Read the latest car news from India: launches, price changes, safety ratings, sales and what they mean for buyers."],
  "/expert-reviews": ["Expert Car Reviews", "Read in-depth car reviews covering design, comfort, performance, mileage and value for money before you buy."],
  "/tips-advice": ["Car Buying Tips and Advice", "Practical car buying, ownership and maintenance tips for Indian drivers, explained in plain language."],
  "/user-reviews": ["Car Owner Reviews", "Read honest reviews from real car owners about comfort, mileage, service and value for money."],
  "/write-review": ["Write a Car Review", "Share your ownership experience and help other buyers by writing a review of your car on Wheelora."],
  "/car-collections": ["Car Collections", "Hand-picked car collections for every need, such as best family cars, best mileage cars and cars under a budget."],
  "/visual-stories": ["Car Visual Stories", "Quick visual stories on cars, launches and buying ideas, built for easy swiping on your phone."],
  "/car-loan": ["Car Loan Guide and EMI", "Understand how a car loan works in India, what affects your EMI and how to compare offers before you apply."],
  "/emi-calculator": ["Car Loan EMI Calculator", "Work out your monthly car loan EMI by loan amount, interest rate and tenure with this free calculator."],
  "/car-insurance": ["Car Insurance Guide", "Learn how car insurance works in India, what is covered and how to pick the right policy for your car."],
  "/about": ["About Wheelora", "Learn who we are, how Wheelora collects and checks car data, and why we built a clear car research site for India."],
  "/careers": ["Careers at Wheelora", "See how to work with Wheelora and join the team building a simple, trustworthy car research site for India."],
  "/contact": ["Contact Wheelora", "Get in touch with the Wheelora team for questions, feedback, corrections or partnership requests."],
  "/faqs": ["Car Buying FAQs", "Answers to common questions about buying a new car in India, from prices and variants to loans and test drives."],
  "/feedback": ["Send Feedback", "Tell us what works and what does not on Wheelora so we can keep improving the site for car buyers."],
  "/advertise": ["Advertise with Wheelora", "Reach car buyers in India by advertising with Wheelora. See the options and how to get in touch with the team."],
  "/partner-dealer": ["Partner Dealer Programme", "Dealers can partner with Wheelora to list their showroom and reach buyers searching for new cars."],
  "/privacy-policy": ["Privacy Policy", "Read how Wheelora collects, uses and protects your information when you use the website."],
  "/terms": ["Terms of Use", "Read the terms that apply when you use the Wheelora website, including content, data and liability."],
  "/image-credits": ["Image Credits and Licences", "Credits and licences for the car photos and open data used on Wheelora."],
  "/shortlist": ["Your Car Shortlist", "Keep your shortlisted cars in one place and compare them side by side whenever you are ready."],
};

/** A short readable name for a main page ("New Cars in India"), or null. */
export const labelFor = (path) => MAIN[path]?.[0] ?? null;

const TAB = {
  price: ["Price in India", "on-road price, ex-showroom price and EMI by variant"],
  specs: ["Specifications & Features", "engine, power, dimensions, safety and features"],
  images: ["Photos & Colours", "photos and colour options"],
  colours: ["Colours", "all colour options and photos"],
  mileage: ["Mileage", "claimed mileage and fuel efficiency"],
  reviews: ["Reviews", "expert and owner reviews"],
  offers: ["Offers & Discounts", "current offers and discounts"],
  emi: ["EMI Calculator", "monthly EMI for each variant"],
  dealers: ["Dealers Near You", "dealers and showrooms"],
  news: ["News", "the latest news and updates"],
  faqs: ["FAQs", "answers to common buyer questions"],
  variants: ["Variants Compared", "every variant with its price and features"],
};

const FILL = [" Compare prices, specs and variants on Wheelora.", " Updated regularly by the Wheelora team.", " Everything you need to decide, in one place."];

/** "Title" or "Title | Wheelora", whichever lands between 30 and 60 characters. */
export function fitTitle(t) {
  let s = String(t).replace(/\s+/g, " ").trim();
  if (`${s} | Wheelora`.length <= 60) s = `${s} | Wheelora`;
  if (s.length < 30) s = `${s} in India`;
  if (s.length > 60) s = s.slice(0, 57).replace(/\s+\S*$/, "").replace(/[,:;|-]+$/, "");
  return s;
}

/** A description between 120 and 160 characters. */
export function fitDesc(d) {
  let s = String(d).replace(/\s+/g, " ").trim();
  for (let i = 0; s.length < 120 && i < FILL.length; i++) s += FILL[i];
  if (s.length > 160) s = `${s.slice(0, 157).replace(/\s+\S*$/, "").replace(/[,;:.]+$/, "")}.`;
  return s;
}

const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/**
 * @param {{path: string, group: string}} p
 * @returns {{title: string, description: string, keywords: string[]} | null}
 */
export function suggestSeo(p, snap) {
  const path = p.path;
  const make = (title, description, keywords) => ({ title: fitTitle(title), description: fitDesc(description), keywords: [...new Set(keywords.map(words).filter(Boolean))].slice(0, 8) });
  if (MAIN[path]) {
    const [label, what] = MAIN[path];
    const base = words(label).replace(/ in india$/, "");
    if (path === "/") return make(label, what, ["new cars in india", "car prices in india", "compare cars", "car reviews india", "car news india"]);
    return make(label, what, [`${base} india`, base, `${base} 2026`, "car news and prices india"]);
  }
  const m = path.match(/^\/cars\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
  if (m) {
    const car = snap.cars.find((c) => c.brandSlug === m[1] && c.slug === m[2]);
    if (!car) return null;
    const [tabTitle, tabWhat] = m[3] ? (TAB[m[3]] ?? [m[3], m[3]]) : ["Price, Mileage & Specs", "price, variants, mileage, colours and specifications"];
    const price = car.min ? ` Prices start at Rs ${(car.min / 100000).toFixed(2).replace(/\.00$/, "")} lakh.` : "";
    return make(`${car.full} ${tabTitle}`, `See ${car.full} ${tabWhat} in India.${m[3] ? "" : price}`, [`${car.full} ${m[3] ? tabTitle.split(" ")[0] : "price"}`, car.full, `${car.full} ${m[3] === "mileage" ? "mileage" : "variants"}`, `${car.full} on road price`]);
  }
  let x = path.match(/^\/brands\/([^/]+)$/);
  if (x) {
    const b = snap.brands.find((q) => q.slug === x[1]);
    if (!b) return null;
    return make(`${b.name} Cars in India: Prices & Models`, `Explore every ${b.name} car on sale in India with prices, variants, mileage and specifications, and compare models side by side.`, [`${b.name} cars`, `${b.name} car price india`, `${b.name} new models`, `${b.name} suv`]);
  }
  x = path.match(/^\/new-cars\/([^/]+)$/);
  if (x && snap.facets[x[1]]) {
    const f = snap.facets[x[1]];
    return make(f.label.replace(/^new cars? ?/i, "").trim() ? `${f.label} in India` : f.h1, f.intro || `${f.label}: browse the cars with prices, variants, mileage and specifications.`, [`${f.label} india`, f.label, `best ${f.label}`]);
  }
  x = path.match(/^\/car-collections\/([^/]+)$/);
  if (x) {
    const c = snap.collections.find((q) => q.slug === x[1]);
    return c ? make(c.title, c.blurb || `${c.title}: hand-picked cars with prices and specifications.`, [c.title, `${c.title} india`]) : null;
  }
  x = path.match(/^\/visual-stories\/([^/]+)$/);
  if (x) {
    const c = snap.stories.find((q) => q.slug === x[1]);
    return c ? make(c.title, c.intro || `${c.title}: a quick visual story on Wheelora.`, [c.title, `${c.title} india`]) : null;
  }
  x = path.match(/^\/news\/topic\/([^/]+)$/);
  if (x && snap.topics[x[1]]) {
    const t = snap.topics[x[1]];
    return make(`${t.label} News India`, t.intro || `The latest ${t.label.toLowerCase()} news from India.`, [`${t.label} news`, `${t.label} news india`, `latest ${t.label} car news`]);
  }
  x = path.match(/^\/compare-cars\/(.+)-vs-(.+)$/);
  if (x) {
    const find = (k) => snap.cars.find((c) => `${c.brandSlug}-${c.slug}` === k)?.full;
    const a = find(x[1]);
    const b = find(x[2]);
    return a && b ? make(`${a} vs ${b}: Which Is Better?`, `Compare the ${a} and ${b} on price, mileage, engine, features and safety to decide which one suits you better.`, [`${a} vs ${b}`, `${a} or ${b}`, `${a} ${b} comparison`]) : null;
  }
  return null; // articles keep their own SEO fields
}
