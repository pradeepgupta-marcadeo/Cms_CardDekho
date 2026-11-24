import assert from "node:assert/strict";
import { test } from "node:test";
import { sameStory, sameText } from "../src/lib/news-text.js";

// Real pairs from the news drafts: one story told twice must be caught, different stories must not.
test("same car, same kind of story, same weeks: duplicate", () => {
  const a = { title: "Toyota Fortuner Launch Date Set For December Global Reveal", carId: 7, category: "launch", date: "2026-11-12" };
  const b = { title: "Toyota Fortuner Launch Details And Upcoming December SUV Debuts", carId: 7, category: "launch", date: "2026-11-13" };
  assert.equal(sameStory(a, b), true);
});

test("same car but months apart, or a different kind of story: not a duplicate", () => {
  const a = { title: "Hyundai Venue Sales Surge in October", carId: 3, category: "sales", date: "2026-11-05" };
  assert.equal(sameStory(a, { title: "Hyundai Venue Sales Rise in January", carId: 3, category: "sales", date: "2027-02-05" }), false);
  assert.equal(sameStory(a, { title: "Next-Gen Hyundai Venue Spied With A Bigger Touchscreen", carId: 3, category: "spy", date: "2026-11-06" }), false);
});

test("roundups sharing only the month, brand or fuel words are different stories", () => {
  assert.equal(sameStory({ title: "New Car Launches November 2026: Denza D9 and Z9 GT" }, { title: "Norton Files Patents for Atlas and Manx R in New Car Launches November 2026" }), false);
  assert.equal(sameStory({ title: "Maruti Suzuki Ertiga Sales Cross 20000 Units in October 2026", carId: 1, category: "sales" }, { title: "Maruti Suzuki Brezza Sales Cross 22,000 Units", carId: 2, category: "sales" }), false);
  assert.equal(sameStory({ title: "Toyota Fortuner Prices Revised Across Petrol And Diesel Trims" }, { title: "Mercedes-Benz Cars in India Will Keep Petrol and Diesel" }), false);
});

test("the same headline reworded is caught even without a car", () => {
  assert.equal(sameStory({ title: "JSW Combat Spied Testing in Daman Ahead of Launch" }, { title: "Unmasked JSW Combat Spied in Daman" }), true);
});

test("text that repeats another article is caught", () => {
  const body = "The new model brings a larger touchscreen, ventilated seats and a panoramic sunroof to the top trims, while the base trims keep the older dashboard layout and analogue dials for now.";
  assert.equal(sameText(body, `Intro line. ${body} More words here.`), true);
  assert.equal(sameText(body, "A completely different article about fuel prices in Delhi and Mumbai this week, with diesel slightly cheaper than last month."), false);
});

test("model codes count, written apart or together", () => {
  assert.equal(sameStory({ title: "New Car Launches November 2026: Denza D9 and Z9 GT" }, { title: "BYD Denza Z9GT Showcased Among Upcoming Cars November 2026" }), true);
});
