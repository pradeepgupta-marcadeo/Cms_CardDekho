// Default content the seed writes once. After that, everything is edited in the CMS.

// Editable website text. `page` is where it appears, `hint` explains the effect.
export const BLOCKS = [
  { key: "home.hero.before", page: "/", label: "Home hero heading: start", value: "Find the car that ", hint: "The first part of the biggest heading on the home page (in white)." },
  { key: "home.hero.highlight", page: "/", label: "Home hero heading: highlighted words", value: "fits your life", hint: "The middle words of the heading, shown in green (lime) with a typing animation." },
  { key: "home.hero.after", page: "/", label: "Home hero heading: end", value: ", not just your budget", hint: "The last part of the heading." },
  { key: "home.shortlist.title", page: "/", label: "Popular cars section title", value: "The cars India is shortlisting", hint: "The heading (H2) of the home page section with the body type tabs." },
  { key: "home.shortlist.sub", page: "/", label: "Popular cars section subtitle", value: "Pick a body style and see what buyers like you are comparing right now.", hint: "The short line under the heading above." },
  { key: "home.budget.title", page: "/", label: "Budget section title", value: "Shop by what you can spend", hint: "The heading of the budget section (under 10 lakh etc.)." },
  { key: "home.budget.sub", page: "/", label: "Budget section subtitle", value: "We start from the budget, because that is where every good decision starts.", hint: "The line under the budget heading." },
  { key: "home.offers.title", page: "/", label: "Offers section title", value: "Offers ending soon", hint: "The heading of the offers section on the home page." },
  { key: "home.offers.sub", page: "/", label: "Offers section subtitle", value: "This month's savings across popular cars, so you can compare them in one place.", hint: "The line under the offers heading." },
  { key: "home.upcoming.title", page: "/", label: "Upcoming cars section title", value: "Coming soon", hint: "The upcoming cars section on the home page." },
  { key: "home.launched.title", page: "/", label: "New launches section title", value: "Just launched", hint: "The newly launched cars section on the home page. A car shows here when its status is set to 'new-launch'." },
  { key: "home.brands.title", page: "/", label: "Brands section title", value: "Browse by brand", hint: "The heading of the brand logos section on the home page." },
  { key: "home.compare.title", page: "/", label: "Comparisons section title", value: "Close calls, settled", hint: "The popular comparisons section on the home page." },
  { key: "home.compare.sub", page: "/", label: "Comparisons section subtitle", value: "The comparisons buyers ask about the most.", hint: "The line under the comparisons heading." },
  { key: "home.read.title", page: "/", label: "News section title", value: "Read before you decide", hint: "The latest news and reviews section on the home page." },
  { key: "home.stories.title", page: "/", label: "Visual stories section title", value: "Visual stories", hint: "The photo stories section on the home page." },
  { key: "home.stories.sub", page: "/", label: "Visual stories subtitle", value: "Quick swipeable picks, from family SUVs to city hatchbacks.", hint: "The line under the visual stories heading." },
  { key: "footer.about", page: "all pages", label: "Footer: about text", value: "Research new cars, compare them honestly and talk to a dealer only when you are ready.", hint: "The line under the site name in the footer of every page." },
];

export const FACETS = [
  ["suv", "SUV cars", "SUV cars for every budget", "SUVs give you higher seating, better ground clearance and a confident view over traffic, which explains why they lead sales across Indian cities.", { body: ["SUV"] }],
  ["hatchback", "Hatchback cars", "Hatchbacks that make city life easy", "Hatchbacks stay popular because they are easy to park, light on fuel and affordable to own, making them natural first cars and second cars.", { body: ["Hatchback"] }],
  ["sedan", "Sedan cars", "Sedans with comfort and boot space", "Sedans offer calm highway manners, a separate boot and a low centre of gravity that makes long journeys noticeably more relaxed for everyone inside.", { body: ["Sedan"] }],
  ["muv", "MUV and 7-seater cars", "MUVs and seven-seaters for big families", "When you regularly travel with parents, children and luggage, a three-row vehicle changes everything, because nobody has to be left behind on a trip.", { any: [{ body: ["MUV"] }, { seatsGte: 7 }] }],
  ["luxury", "Luxury cars", "Luxury cars for a quieter drive", "Luxury cars add refinement, cabin quality and strong performance, with ownership costs that are worth understanding properly before you sign any papers.", { body: ["Luxury"] }],
  ["under-10-lakh", "Cars under 10 lakh", "Best cars priced under ₹10 lakh", "This budget covers the cars most Indian families actually buy, from hatchbacks to micro SUVs, with good safety ratings now available at lower prices than before.", { minLt: 10 }],
  ["under-15-lakh", "Cars under 15 lakh", "Best cars priced under ₹15 lakh", "At this level you can choose compact SUVs, roomy sedans and well-equipped family cars, often with automatic gearboxes, sunroofs and connected features included.", { minLt: 15 }],
  ["under-25-lakh", "Cars under 25 lakh", "Best cars priced under ₹25 lakh", "This range unlocks larger SUVs, electric cars and hybrids, along with driver-assistance features that were reserved for far costlier cars just a few years ago.", { minLt: 25 }],
  ["above-25-lakh", "Cars above 25 lakh", "Premium cars priced above ₹25 lakh", "Above this price you are paying for capability, comfort and brand, from serious full-size SUVs and big electric crossovers to genuine imported luxury cars.", { minGte: 25 }],
];

export const COLLECTIONS = [
  ["best-first-cars", "Best first cars for new drivers", "Easy to drive, simple to park and gentle on the monthly budget.", { maxLt: 13, notStatus: "upcoming" }],
  ["safest-cars-in-india", "Five-star safety picks", "Cars carrying a five-star rating in our catalogue, across all budgets.", { ncap: 5, notStatus: "upcoming", maxLt: 30 }],
  ["low-running-cost-cars", "Lowest running cost cars", "Efficient petrol, CNG and electric choices for high monthly mileage.", { fuelsAny: ["CNG", "Electric", "Hybrid"], maxLt: 25 }],
  ["weekend-adventure-cars", "Weekend adventure machines", "High ground clearance and tough suspension for roads less travelled.", { slugs: ["thar", "scorpio-n", "fortuner", "punch", "harrier"] }],
];

export const STORIES = [
  ["best-family-suvs", "Five family SUVs worth a test drive", "Space, safety and comfort for growing families", { body: ["SUV"], seatsGte: 5, maxLt: 30 }],
  ["electric-cars-to-watch", "Electric cars to watch this season", "Range, charging speed and design that stand out", { fuelsAny: ["Electric"] }],
  ["hatchbacks-for-the-city", "Hatchbacks made for city streets", "Small footprints with surprisingly practical cabins", { body: ["Hatchback"] }],
  ["sedans-that-feel-premium", "Sedans that feel a class above", "Big boots, quiet cabins and calm highway manners", { body: ["Sedan"] }],
  ["seven-seaters-for-big-families", "Seven-seaters for big families", "Three rows that everybody can actually use", { seatsGte: 7 }],
  ["luxury-picks-of-the-year", "Luxury picks of the year", "Comfort, technology and quiet confidence", { body: ["Luxury"] }],
];

// Rule keys an editor can use in a list's "Which cars" box.
export const RULE_HELP = `{"body":["SUV"]} = only SUVs | {"minLt":10} = starting price under 10 lakh | {"minGte":25} = 25 lakh or more | {"maxLt":30} = top model under 30 lakh | {"seatsGte":7} = 7 or more seats | {"fuelsAny":["CNG","Electric"]} = any of these fuels | {"ncap":5} = 5 star | {"notStatus":"upcoming"} = leave out upcoming cars | {"slugs":["thar","punch"]} = only these cars | {"any":[{...},{...}]} = any one of these rules`;
