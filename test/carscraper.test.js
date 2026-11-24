import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, isDue, lastSlot, nextRun, optionArgs, parseJob, parseOptions } from "../src/lib/carscraper-schedule.js";
import { MODES, parseQuality, readLine, stepsFor } from "../src/lib/carscraper.js";
import { carPictures, carRow, describeChange, toInt, variantRow } from "../src/lib/cardekho-import.js";

const HOUR = 3600 * 1000;
// 2026-11-16 10:00 IST = 04:30 UTC (a Monday)
const MON_10_IST = Date.UTC(2026, 10, 16, 4, 30);

test("daily slot is today's time when it has passed, else yesterday's", () => {
  const job = { freq: "daily", time: "03:00", enabled: true };
  assert.equal(lastSlot(job, MON_10_IST), Date.UTC(2026, 10, 15, 21, 30)); // 03:00 IST today
  const late = { ...job, time: "22:00" };
  assert.equal(lastSlot(late, MON_10_IST), Date.UTC(2026, 10, 15, 16, 30)); // 22:00 IST yesterday
});

test("weekly slot goes back to the chosen weekday", () => {
  const job = { freq: "weekly", time: "04:00", weekday: 6, enabled: true }; // Saturday
  assert.equal(lastSlot(job, MON_10_IST), Date.UTC(2026, 10, 13, 22, 30)); // Sat 14 Nov 04:00 IST
  const today = { ...job, weekday: 1, time: "11:00" }; // Monday, later today -> last week
  assert.equal(lastSlot(today, MON_10_IST), Date.UTC(2026, 10, 9, 5, 30));
});

test("a new schedule does not fire for a slot before it was created; a missed one fires once", () => {
  const job = { freq: "daily", time: "03:00", enabled: true, createdAt: MON_10_IST - HOUR };
  assert.equal(isDue(job, undefined, MON_10_IST), false);
  assert.equal(isDue(job, undefined, MON_10_IST + 18 * HOUR), true); // next day 04:00 IST
  assert.equal(isDue(job, MON_10_IST + 18 * HOUR, MON_10_IST + 19 * HOUR), false);
  assert.equal(isDue({ ...job, enabled: false }, undefined, MON_10_IST + 18 * HOUR), false);
});

test("hourly jobs run every N hours", () => {
  const job = { freq: "hourly", every: 6, enabled: true, createdAt: MON_10_IST };
  assert.equal(isDue(job, undefined, MON_10_IST + 5 * HOUR), false);
  assert.equal(isDue(job, undefined, MON_10_IST + 6 * HOUR), true);
  assert.equal(nextRun(job, MON_10_IST + HOUR, MON_10_IST + 2 * HOUR), MON_10_IST + 7 * HOUR);
  assert.equal(describe(job), "Every 6 hours");
});

test("schedule form is checked", () => {
  const j = parseJob({ mode: "cars", freq: "weekly", time: "4:05", weekday: "1", refresh: "on", brand: "Tata" }, MODES);
  assert.deepEqual([j.time, j.weekday, j.options.refresh, j.options.brand], ["04:05", 1, true, "Tata"]);
  assert.throws(() => parseJob({ mode: "nope", freq: "daily" }, MODES), /Choose what/);
  assert.throws(() => parseJob({ mode: "cars", freq: "daily", time: "25:00" }, MODES), /Time/);
  assert.throws(() => parseOptions({ brand: "tata; rm -rf" }), /Brand/);
  assert.deepEqual(parseOptions({ brand: "  Maruti   Suzuki ", city: " chandigarh,  BENGALURU " }), { refresh: false, brand: "Maruti Suzuki", city: "chandigarh, BENGALURU", limit: null, images: false });
  assert.throws(() => parseOptions({ city: "pune; rm -rf /" }), /City/);
  assert.throws(() => parseOptions({ limit: "0" }), /Max/);
});

test("options become scrape.py flags; car scrapes end with save + photos + page copy by themselves", () => {
  assert.deepEqual(optionArgs({ refresh: true, brand: "kia", limit: 5, images: true }), ["--refresh", "--brand", "kia", "--limit", "5"]);
  const kinds = (mode) => stepsFor(mode).map((s) => (s.py ? "py" : s.db ? "db" : s.extras ? "extras" : s.spins ? "spins" : s.copy ? `copy:${s.newOnly ? "new" : "all"}` : `${s.site ? "site" : "photos"}:${s.kind ?? "all"}`));
  assert.deepEqual(kinds("cars"), ["py", "db", "photos:launched", "site:launched", "copy:new"]);
  assert.deepEqual(kinds("latest"), ["py", "db", "photos:launched", "site:launched", "copy:new"]);
  assert.deepEqual(kinds("upcoming"), ["py", "db", "photos:upcoming", "site:upcoming", "copy:new"]);
  assert.deepEqual(kinds("variants"), ["py", "db", "site:launched"]);
  assert.deepEqual(kinds("everything").slice(-3), ["photos:all", "site:all", "copy:new"]);
  assert.deepEqual(kinds("car_copy"), ["py", "extras", "copy:all"]);
  assert.deepEqual(kinds("gallery"), ["py", "extras", "photos:all", "site:all"]);
  assert.deepEqual(kinds("threesixty"), ["py", "spins"]);
  assert.deepEqual(kinds("website"), ["site:all"]);
});

test("scraped records map to database columns", () => {
  const car = carRow({ slug: "tata/punch", name: "Tata Punch", ex_showroom_min: "600000", seats: "5", variants: [{}, {}], scraped_at: "2026-11-16T12:00:00" }, "launched");
  assert.deepEqual([car[0], car[1], car[8], car[13], car[18], car[24]], ["tata/punch", "launched", 600000, 5, 2, "2026-11-16T12:00:00+05:30"]);
  const v = variantRow({ url: "u", car_slug: "tata/punch", on_road: 712345.6, airbags: "-" }, "upcoming");
  assert.deepEqual([v[0], v[2], v[12], v[17]], ["u", "upcoming", 712346, null]);
  assert.equal(toInt("12 kmpl"), null);
});

test("change text names what changed", () => {
  const w = [["price_range", "price"], ["variants_count", "variants"]];
  assert.equal(describeChange({ price_range: "6 - 10 Lakh", variants_count: 8 }, { price_range: "6.2 - 10 Lakh", variants_count: 8 }, w), "price 6 - 10 Lakh → 6.2 - 10 Lakh");
  assert.match(describeChange({ price_range: "x" }, { price_range: "x" }, w), /details/);
});

test("pictures of a car are listed once with titles", () => {
  const p = carPictures({ pictures: ["https://a/img/front-left-side-47.jpg", "https://a/img/front-left-side-47.jpg", "http://insecure/x.jpg"], colours: [{ name: "Red", image: "https://a/red.jpg" }] });
  assert.deepEqual(p.map((x) => [x.kind, x.title, x.sort]), [["picture", "front left side", 0], ["colour", "Red", 1]]);
});

test("log lines update progress and counts", () => {
  const s = { done: 0, total: 0, counts: { NEW: 0, UPDATED: 0, SAME: 0, skipped: 0 }, changes: [] };
  readLine("277 models found, 0 already saved, 277 to fetch -> cars.jsonl", s);
  readLine("[1/277] Tata Punch | 6 - 10 Lakh | 8 variants | 9 pictures | 30 specs | UPDATED (price_range: 6 - 10 Lakh -> 6.2 - 10 Lakh)", s);
  readLine("[2/277] Tata Nexon | 8 - 15 Lakh | 40 variants | 9 pictures | 30 specs | SAME", s);
  readLine("[3/277] tata/old: skipped (not a car page / error)", s);
  assert.deepEqual([s.done, s.total, s.counts.UPDATED, s.counts.SAME, s.counts.skipped, s.changes.length], [3, 277, 1, 1, 1, 1]);
});

test("quality report is parsed", () => {
  const q = parseQuality("cars: 277\nfield: missing / cars it applies to\nname: 0 / 277\nmileage: 49 / 207   e.g. a/b, c/d\n");
  assert.deepEqual(q, [{ field: "name", missing: 0, of: 277, examples: [] }, { field: "mileage", missing: 49, of: 207, examples: ["a/b", "c/d"] }]);
});

test("CarDekho sheets map to the website's feature keys", async () => {
  const { featureSet, highlights, yes, fuelOf, bodyOf, variantName, photoKind, overviewFrom } = await import("../src/lib/catalogue-sync.js");
  const sheet = {
    features: {
      Safety: { "No. of Airbags": "6", "Electronic Stability Control (ESC)": "Yes", "Rear Camera": "With Guidedlines", "360 View Camera": "Not Available" },
      "Entertainment & Communication": { "Touchscreen Size": "10.25 inch", "Apple CarPlay": "Wireless", "Android Auto": "Yes" },
      Exterior: { Sunroof: "Panoramic" },
      "ADAS Feature": { "Adaptive Cruise Control": "Not Available", "Lane Keep Assist": "Yes" },
    },
  };
  const f = featureSet(sheet);
  assert.deepEqual([f.airbags, f.esc, f.rearCamera, f.camera360, f.touchscreenIn, f.wirelessCarPlayAndroidAuto, f.sunroof, f.adas, f.cruiseControl], [6, true, true, false, 10.25, true, "panoramic", "Yes", null]);
  assert.deepEqual(highlights(f), ["ADAS", "Panoramic sunroof", "10.25-inch touchscreen", "Wireless Android Auto and Apple CarPlay"]);
  assert.deepEqual([yes("No"), yes("Front Only"), yes(undefined)], [false, true, null]);
  assert.deepEqual(["Petrol Hybrid", "Electric", "CNG", "Diesel / Petrol"].map(fuelOf), ["Hybrid", "Electric", "CNG", "Diesel"]);
  assert.deepEqual([bodyOf("bmw", "Sedans"), bodyOf("tata", "Hatchback"), bodyOf("kia", "Minivan"), bodyOf("tata", "Coupe")], ["Luxury", "Hatchback", "MUV", "Sedan"]);
  assert.equal(variantName("Aeris Smart Petrol MT", { name: "Tata Aeris", model: "Aeris", brand: "Tata" }), "Smart Petrol MT");
  assert.deepEqual(["front left side", "rear view", "dashboard", "headlight", "side view (left)"].map((t) => photoKind(t, "picture")), ["front", "rear", "interior", "detail", "side"]);
  assert.equal(photoKind("Red", "colour"), "side");
  assert.equal(photoKind("Boot (Closed)", "picture", "https://stimg.cardekho.com/images/carexteriorimages/930x620/BMW/3-Series/1/boot-closed-1.jpg"), "rear");
  assert.equal(overviewFrom([{ title: "Overview", text: "One. Two. Three. Four." }])[0].p.length, 2);
});

test("a saved car becomes website rows with lakh prices and colour photos", async () => {
  const { mapCar } = await import("../src/lib/catalogue-sync.js");
  const row = { slug: "tata/punch", kind: "launched", brand: "Tata", model: "Punch", name: "Tata Punch", body_type: "SUV", fuel: "Petrol", seats: 5, url: "https://x/tata/punch", data: { colours: [{ name: "Red", hex: "#f00" }, { name: "Odd", hex: "bad" }] } };
  const variants = [
    { data: { variant: "Punch Pure", fuel: "Petrol", transmission: "Manual", ex_showroom: 612345, engine_cc: "1199 cc", max_power: "86bhp@6000rpm", max_torque: "115Nm@3150rpm", specification: { "Dimensions & Capacity": { Length: "3827 mm", "Boot Space": "366 Litres" } }, features: {} } },
    { data: { variant: "Punch Creative AMT", fuel: "Petrol", transmission: "Automatic", ex_showroom: 1012345, engine_cc: "1199 cc", max_power: "86bhp@6000rpm", max_torque: "115Nm@3150rpm", specification: {}, features: {} } },
  ];
  const photos = [{ kind: "picture", title: "front left side", url: "u1", w: 630, h: 420 }, { kind: "colour", title: "Red", url: "u2", w: 360, h: 240 }];
  const m = mapCar(row, variants, photos);
  assert.deepEqual([m.brandSlug, m.slug, m.name, m.min, m.max, m.auto, m.engine, m.power, m.torque, m.boot, m.dims.length], ["tata", "punch", "Punch", 6.12, 10.12, true, "1199 cc", "86 bhp", "115 Nm", 366, 3827]);
  assert.deepEqual(m.variants.map((v) => [v.name, v.trans]), [["Pure", "Manual"], ["Creative AMT", "Automatic"]]);
  assert.deepEqual(m.colors[1], { name: "Odd", hex: "#9ca3af" });
  assert.deepEqual(m.photos.map((p) => [p.kind, p.colour]), [["front", null], ["side", "Red"]]);
  assert.equal(m.status, "on-sale");
});

test("pictures are asked for in HD, with the listed size as fallback", async () => {
  const { hdUrl, carPictures } = await import("../src/lib/cardekho-import.js");
  assert.equal(hdUrl("https://s/images/carexteriorimages/630x420/Tata/Punch/1/2/front-left-side-47.jpg"), "https://s/images/carexteriorimages/930x620/Tata/Punch/1/2/front-left-side-47.jpg");
  assert.equal(hdUrl("https://s/images/car-images/360x240/Tata/Punch/1/2/Red.jpg"), "https://s/images/car-images/930x620/Tata/Punch/1/2/Red.jpg");
  const [p] = carPictures({ pictures: ["https://s/i/630x420/a.jpg", "https://s/i/930x620/a.jpg"] });
  assert.deepEqual([p.url, p.original], ["https://s/i/930x620/a.jpg", "https://s/i/630x420/a.jpg"]);
  assert.equal(carPictures({ pictures: ["https://s/i/630x420/a.jpg", "https://s/i/930x620/a.jpg"] }).length, 1);
});

test("comparison pairs follow CarDekho's compare-with lists", async () => {
  const { pickPairs } = await import("../src/lib/catalogue-sync.js");
  const cars = [
    { id: 1, slug: "tata/punch", popularity: 90, rivals: ["tata/nexon", "hyundai/exter"] },
    { id: 2, slug: "tata/nexon", popularity: 85, rivals: ["tata/punch", "maruti/brezza"] },
    { id: 3, slug: "hyundai/exter", popularity: 80, rivals: ["tata/punch"] },
    { id: 4, slug: "maruti/brezza", popularity: 70, rivals: ["gone/car", "tata/nexon"] },
  ];
  assert.deepEqual(pickPairs(cars), [[1, 2], [2, 4], [3, 1]]);
  assert.equal(pickPairs(cars, 1).length, 1);
});

test("odd picture lists do not stop the photo import", async () => {
  const { carPictures } = await import("../src/lib/cardekho-import.js");
  const one = "https://s/images/carexteriorimages/360x240/Audi/Q6/1/2/front-left-side.jpg";
  assert.equal(carPictures({ pictures: one }).length, 1);
  assert.equal(carPictures({ pictures: [...one] }).length, 1);
  assert.equal(carPictures({ pictures: ["not a url", 5, null], colours: [{ name: "x", image: "::" }] }).length, 0);
});

test("names lose the repeated brand and latest cars become new launches", async () => {
  const { modelName, mapCar } = await import("../src/lib/catalogue-sync.js");
  assert.equal(modelName("Hyundai 2027 Hyundai i20", "Hyundai"), "2027 i20");
  assert.equal(modelName("Land Rover Range Rover Velar", "Land Rover"), "Range Rover Velar");
  assert.equal(modelName("BMW", "BMW", "BMW X"), "BMW X");
  const row = { slug: "tata/punch", kind: "launched", brand: "Tata", model: "Punch", name: "Tata Punch", data: {} };
  assert.equal(mapCar(row, [], [], new Set(["tata/punch"])).status, "new-launch");
  assert.equal(mapCar(row, [], []).status, "on-sale");
  assert.equal(mapCar({ ...row, kind: "upcoming" }, [], [], new Set(["tata/punch"])).status, "upcoming");
});

test("strong and plug-in hybrids are Hybrid; mild and smart hybrids stay petrol", async () => {
  const { isHybrid } = await import("../src/lib/catalogue-sync.js");
  for (const t of ["Innova Hycross ZX Hybrid", "M15D With Strong Hybrid", "3.0L 6-Cylinder Plug-in Hybrid", "Strong Hybrid E-Tech 160"]) assert.equal(isHybrid(t), true, t);
  for (const t of ["K15C Smart Hybrid", "K15C With Mild Hybrid System", "4.4L Twin-Turbo Mild-Hybrid V8", "1.5L Petrol"]) assert.equal(isHybrid(t), false, t);
});

test("fuel price: city rate, else state rate, else nothing (PPAC is tried for those)", async () => {
  const { pickFuel } = await import("../src/lib/fuel-import.js");
  const data = { cities: { "new-delhi": { petrol: 102.12, diesel: 95.2, cng: 86.98 } }, states: { "uttar-pradesh": { petrol: 101.66, diesel: 95.14, cng: 107 } } };
  assert.deepEqual(pickFuel({ slug: "new-delhi", state: "Delhi" }, data), { petrol: 102.12, diesel: 95.2, cng: 86.98, source: "CarDekho" });
  assert.equal(pickFuel({ slug: "kanpur", state: "Uttar Pradesh" }, data).source, "CarDekho (Uttar Pradesh state rate)");
  assert.equal(pickFuel({ slug: "goa", state: "Goa" }, data), null);
});

test("real on-road prices are matched to variants by their source address", async () => {
  const { cityPriceMap, mapCar } = await import("../src/lib/catalogue-sync.js");
  const u1 = "https://x/overview/Punch_Pure.htm";
  const u2 = "https://x/overview/Punch_Creative.htm";
  const map = cityPriceMap([
    { city_slug: "mumbai", data: { variants: [{ url: u1, on_road: 699410 }, { url: u2, on_road: 1185435 }], base_breakup: { url: u1, rto: 65804, insurance: 33916, other: 0 } } },
    { city_slug: "kanpur", data: { variants: [{ url: u1, on_road: 684762 }] } },
  ]);
  assert.deepEqual(map[u1], { mumbai: { total: 699410, rto: 65804, insurance: 33916, other: 0 }, kanpur: { total: 684762 } });
  assert.deepEqual(map[u2], { mumbai: { total: 1185435 } });
  const row = { slug: "tata/punch", kind: "launched", brand: "Tata", model: "Punch", name: "Tata Punch", data: {} };
  const m = mapCar(row, [{ data: { variant: "Punch Pure", url: u1, fuel: "Petrol", transmission: "Manual", ex_showroom: 600000 } }], [], new Set(), map);
  assert.equal(m.variants[0].onRoad.kanpur.total, 684762);
});

test("brands are found however they are typed", async () => {
  const { matchBrand } = await import("../src/lib/name-match.js");
  const brands = [["maruti", "Maruti"], ["mercedes-benz", "Mercedes-Benz"], ["tata", "Tata"], ["toyota", "Toyota"], ["land-rover", "Land Rover"], ["volkswagen", "Volkswagen"], ["hyundai", "Hyundai"], ["kia", "Kia"]].map(([slug, name]) => ({ slug, name }));
  for (const [typed, slug] of [["TATA", "tata"], ["Maruti Suzuki", "maruti"], ["merc", "mercedes-benz"], ["LAND-ROVER", "land-rover"], ["vw", "volkswagen"], ["huyndai", "hyundai"], ["toyta", "toyota"]]) assert.equal(matchBrand(typed, brands).brand?.slug, slug, typed);
  const none = matchBrand("xyz", brands);
  assert.equal(none.brand, null);
});

test("gallery photos: angle of each exterior shot, kind from the title or the interior folder", async () => {
  const { angleOf, photoKind } = await import("../src/lib/catalogue-sync.js");
  const cases = [["Front View", 0], ["Front Left Quarter View", 45], ["Side Profile View (Left)", 90], ["Rear Left Three Quarter View", 135], ["Rear View", 180], ["Driving: Rear Right Three Quarter View", 225], ["Side Profile View (Right)", 270], ["Front Right Quarter View", 315], ["Front Grille", null], ["Dashboard", null]];
  for (const [t, a] of cases) assert.equal(angleOf(t), a, t);
  assert.equal(photoKind("Rear Seats", "picture", "https://x/carinteriorimages/930x620/a.jpg"), "interior");
  assert.equal(photoKind("Rear Left Three Quarter View", "picture", ""), "rear");
  assert.equal(photoKind("Side Profile View (Right)", "picture", ""), "side");
});

test("full gallery is used when the scrape has it; long captions give way to the file name", async () => {
  const { carPictures } = await import("../src/lib/cardekho-import.js");
  const pics = carPictures({
    gallery: [
      { title: "Front Left Quarter View", image: "https://stimg.cardekho.com/images/carexteriorimages/930x620/T/T/1/front-left-side-47.jpg" },
      { title: "The facelift front look is sharp with sleek LED headlamps and a sporty grille", image: "https://stimg.cardekho.com/images/carexteriorimages/930x620/T/T/1/exterior-image-164.jpg" },
    ],
    pictures: ["https://stimg.cardekho.com/images/carexteriorimages/930x620/T/T/1/front-left-side-47.jpg"],
  });
  assert.equal(pics.length, 2, "the same picture is not listed twice");
  assert.deepEqual(pics.map((p) => p.title), ["Front Left Quarter View", "exterior image"]);
});

test("360 records: newest line per car wins, broken lines are skipped", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const { readSpins } = await import("../src/lib/spin-import.js");
  const dir = mkdtempSync(path.join(tmpdir(), "spins-"));
  writeFileSync(
    path.join(dir, "threesixty.jsonl"),
    [
      JSON.stringify({ slug: "tata/tiago", found: false }),
      "{broken",
      JSON.stringify({ slug: "tata/tiago", found: true, views: { closed: { colour: "cf4b44", version: "1", frames: ["a", "b"] } } }),
    ].join(String.fromCharCode(10)),
  );
  const m = readSpins(dir);
  assert.equal(m.size, 1);
  assert.equal(m.get("tata/tiago").views.closed.frames.length, 2);
});
