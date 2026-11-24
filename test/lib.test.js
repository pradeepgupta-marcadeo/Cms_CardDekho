import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJson } from "../src/lib/ai.js";
import { carKeywords, pickForPath } from "../src/lib/keywords.js";
import { checkSeo } from "../src/lib/seo-check.js";
import { countWords, sectionsFromText, sectionsToText, slugify } from "../src/lib/text.js";
import { bodyOf, highlights, mapModel, taxRulesOf } from "../src/importers/variantwise.js";
import { parsePpac } from "../src/importers/ppac.js";
import { kindFromTitle } from "../src/importers/commons.js";

test("slugify makes URL-safe slugs", () => {
  assert.equal(slugify("Mahindra XUV 3XO"), "mahindra-xuv-3xo");
  assert.equal(slugify("  Škoda Kylaq!! "), "skoda-kylaq");
});

test("article text round-trips through ## headings and blank lines", () => {
  const text = "Intro line.\n\n## Price\n\nIt costs less.\n\nSecond para.\n\n## Verdict\n\nBuy it.";
  const sections = sectionsFromText(text);
  assert.deepEqual(sections.map((s) => s.h), ["", "Price", "Verdict"]);
  assert.equal(sections[1].p.length, 2);
  assert.equal(sectionsFromText(sectionsToText(sections)).length, 3);
  assert.equal(countWords(sections), 11);
});

test("SEO check follows the guardrail ranges and flags stuffing", () => {
  const good = checkSeo({
    title: "Tata Punch price in India: variants and on-road cost",
    description: "See the Tata Punch price in India for every variant, with on-road costs, mileage and features explained simply so you can pick the right version.",
    h1: "Tata Punch price and variants explained",
    sections: [{ h: "Tata Punch price", p: ["The Tata Punch price starts low and the range is wide. ".repeat(20)] }, { h: "Which to buy", p: ["Pick the middle trim. ".repeat(20)] }],
    primary: "tata punch price",
    minWords: 100,
  });
  assert.ok(good.checks.find((c) => c.label.startsWith("Title length")).ok);
  assert.ok(good.checks.find((c) => c.label.startsWith("Description length")).ok);
  const stuffed = checkSeo({ title: "x".repeat(40), description: "y".repeat(130), h1: "h", sections: [{ h: "a", p: ["punch ".repeat(50)] }, { h: "b", p: ["punch"] }], primary: "punch" });
  assert.equal(stuffed.checks.find((c) => c.label.startsWith("Keyword density")).ok, false);
  const same = checkSeo({ title: "Same heading here for both of them", description: "", h1: "Same heading here for both of them" });
  assert.equal(same.checks.find((c) => c.label.startsWith("H1 is different")).ok, false);
});

test("keyword bank covers the patterns Indian buyers search", () => {
  const list = carKeywords({ brand: "Tata", brandSlug: "tata", name: "Punch", slug: "punch", status: "on-sale", fuels: ["Petrol", "CNG"], auto: true }, { cities: [{ slug: "pune", name: "Pune" }], rivals: [{ name: "Exter", pairSlug: "tata-punch-vs-hyundai-exter" }] });
  const phrases = list.map((k) => k.phrase);
  for (const p of ["tata punch", "punch price", "punch on road price in pune", "punch vs exter", "punch cng price", "punch mileage"]) assert.ok(phrases.includes(p), p);
  const pick = pickForPath(list, "/cars/tata/punch/price");
  assert.equal(pick.primary, "punch price");
});

test("AI replies are parsed even with code fences or chatter", () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Here you go: {"b":[1,2]} thanks'), { b: [1, 2] });
  assert.throws(() => parseJson("no json"));
});

test("VariantWise models map to our car fields", () => {
  const model = {
    id: "tata-punch", brand: "Tata", name: "Punch", bodyStyle: "suv", seats: 5, lengthMm: 3827, bootLitres: 366,
    engines: [{ id: "p", fuel: "petrol", displacementCc: 1199, powerPs: 88, torqueNm: 115, officialEfficiency: 20.1 }, { id: "c", fuel: "cng", displacementCc: 1199, powerPs: 73, torqueNm: 103 }],
    trims: [{ id: "pure", name: "Pure", level: 0, features: { airbags: 6, sunroof: "none" } }, { id: "creative", name: "Creative", level: 3, features: { airbags: 6, sunroof: "single-pane", touchscreenIn: 10.25 } }],
    variants: [{ id: "pure-mt", trimId: "pure", engineId: "p", transmission: "5MT", price: 6.2 }, { id: "creative-amt", trimId: "creative", engineId: "p", transmission: "5AMT", price: 9.4 }, { id: "pure-cng", trimId: "pure", engineId: "c", transmission: "5MT", price: 7.3 }],
  };
  const m = mapModel(model);
  assert.equal(m.min, 6.2);
  assert.equal(m.max, 9.4);
  assert.deepEqual(m.fuels, ["Petrol", "CNG"]);
  assert.equal(m.auto, true);
  assert.equal(m.mileage, "20.1 kmpl");
  assert.equal(m.variants.length, 3);
  assert.equal(new Set(m.variants.map((v) => v.name)).size, 3);
  assert.equal(bodyOf({ brand: "BMW", bodyStyle: "sedan" }), "Luxury");
  assert.equal(bodyOf({ brand: "Kia", bodyStyle: "mpv" }), "MUV");
  assert.ok(highlights({ sunroof: "panoramic", airbags: 6 }).includes("Panoramic sunroof"));
  assert.deepEqual(taxRulesOf({ rules: [{ fuels: ["petrol"], slabs: [{ uptoRs: 600000, pct: 4 }] }] })[0], { fuels: ["Petrol"], slabs: [{ uptoRs: 600000, pct: 4, flatRs: null }], confidence: null });
});

test("PPAC table row parses into four metros", () => {
  const r = parsePpac("Table Posted: 12-Nov-26\n12-Nov-26 102.12 111.21 107.77 113.51 12-Nov-26 95.20 97.83 99.55 99.82\n");
  assert.equal(r.date, "2026-11-12");
  assert.deepEqual(r.prices[1], { city: "Mumbai", petrol: 111.21, diesel: 97.83 });
});

test("Commons titles hint at the photo angle", () => {
  assert.equal(kindFromTitle("File:Tata Punch interior dashboard.jpg"), "interior");
  assert.equal(kindFromTitle("File:Tata Punch rear view.jpg"), "rear");
  assert.equal(kindFromTitle("File:Tata Punch 2024.jpg"), "front");
});
