import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanHtml, sectionsToHtml } from "../src/lib/rich.js";
import { checkSeo } from "../src/lib/seo-check.js";
import { countWords, flattenSections } from "../src/lib/text.js";

const sections = [
  {
    h: "Prices by variant",
    p: ["The range starts at a friendly price."],
    bullets: ["Petrol manual", "Diesel automatic"],
    steps: ["Pick a variant", "Book online"],
    table: { head: ["Variant", "Price"], rows: [["E", "Rs 11 lakh"], ["SX", "Rs 15 lakh"]] },
  },
];

test("sections with lists and a table become editor-ready HTML that survives sanitising", () => {
  const html = sectionsToHtml(sections);
  assert.match(html, /<ul><li>Petrol manual<\/li>/);
  assert.match(html, /<ol><li>Pick a variant<\/li>/);
  assert.match(html, /<figure class="table"><table><thead><tr><th>Variant<\/th>/);
  assert.equal(cleanHtml(html).includes("<table>"), true);
  assert.equal(cleanHtml(html).includes("<ol>"), true);
});

test("list and table text counts as words and is seen by the SEO checks", () => {
  const flat = flattenSections(sections);
  assert.ok(countWords(flat) > countWords([{ h: sections[0].h, p: sections[0].p }]));
  const seo = checkSeo({ title: "t", description: "d", h1: "h", sections, primary: "rs 15 lakh" });
  assert.ok(seo.words > 8);
});
