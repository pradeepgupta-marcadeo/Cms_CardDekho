import assert from "node:assert/strict";
import { test } from "node:test";
import { researchText } from "../src/lib/car-copy.js";

test("review research becomes plain notes: pros, cons, verdict and rated sections (verdict once)", () => {
  const r = researchText({
    pros: ["Premium cabin"],
    cons: ["Shallow boot"],
    verdict: "A complete family SUV.",
    review_sections: [
      { title: "Interior", rating: 4, text: "Soft-touch dashboard." },
      { title: "Verdict", rating: null, text: "A complete family SUV." },
    ],
  });
  assert.match(r.notes, /Strengths reviewers point out: Premium cabin/);
  assert.match(r.notes, /Weak points reviewers point out: Shallow boot/);
  assert.match(r.notes, /Interior \(rated 4\/5\): Soft-touch dashboard\./);
  assert.equal(r.notes.match(/A complete family SUV/g).length, 1);
});

test("older reviews (sections only) and no review at all", () => {
  assert.match(researchText({ expert_review: [{ title: "Safety", text: "Six airbags." }] }).notes, /Safety: Six airbags\./);
  assert.deepEqual(researchText(null), { notes: "", all: "" });
});

test("long research is cut for the prompt but kept whole for the copy check", () => {
  const r = researchText({ review_sections: [{ title: "Overview", text: "word ".repeat(3000) }] });
  assert.ok(r.notes.length <= 6003);
  assert.ok(r.all.length > 6003);
});
