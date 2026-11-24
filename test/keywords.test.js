import assert from "node:assert/strict";
import { test } from "node:test";
import { carKeywords, joinNames } from "../src/lib/keywords.js";
import { bankFor } from "../src/lib/keyword-sync.js";

const creta = { brand: "Hyundai", brandSlug: "hyundai", name: "Creta", slug: "creta", status: "on-sale", fuels: ["Petrol", "Diesel"], auto: true };

test("head terms and long-tail phrases, each aimed at the page that answers it", () => {
  const list = carKeywords(creta, { cities: [{ name: "Pune", slug: "pune" }], variants: [{ name: "SX (O)", slug: "sx-o" }], year: 2026 });
  const at = (p) => list.find((k) => k.phrase === p)?.target_path;
  assert.equal(at("hyundai creta"), "/cars/hyundai/creta");
  assert.equal(at("creta on road price"), "/cars/hyundai/creta/price");
  assert.equal(at("creta top model price"), "/cars/hyundai/creta/variants");
  assert.equal(at("creta on road price in pune"), "/cars/hyundai/creta/price-in-pune");
  assert.equal(at("creta sx (o) price"), "/cars/hyundai/creta/variants/sx-o");
  assert.equal(at("creta diesel mileage"), "/cars/hyundai/creta/mileage");
  assert.equal(at("creta price 2026"), "/cars/hyundai/creta/price");
  assert.ok(!list.some((k) => /offers|discount/.test(k.phrase)), "no phrases for the removed offers pages");
  assert.equal(new Set(list.map((k) => k.phrase)).size, list.length, "no phrase twice");
});

test("no mileage page, no mileage phrases", () => {
  const list = carKeywords({ ...creta, hasMileage: false });
  assert.ok(!list.some((k) => k.target_path.endsWith("/mileage")));
});

test("variant names do not repeat the model name", () => {
  assert.equal(joinNames("Urban Cruiser Hyryder", "Hyryder G Opt"), "urban cruiser hyryder g opt");
  assert.equal(joinNames("Creta", "SX"), "creta sx");
});

test("the bank gives each phrase to one page only; the more popular car wins a shared phrase", () => {
  const snap = {
    generatedAt: "2026-11-19T00:00:00Z",
    cities: [],
    comparePairs: [["hyundai-creta", "kia-seltos"]],
    cars: [
      { ...creta, key: "hyundai-creta", popularity: 90, variants: [], mileage: "17 kmpl" },
      { brand: "Kia", brandSlug: "kia", name: "Seltos", slug: "seltos", status: "on-sale", fuels: ["Petrol"], auto: false, key: "kia-seltos", popularity: 80, variants: [], mileage: "" },
    ],
  };
  const bank = bankFor(snap);
  assert.equal(new Set(bank.map((k) => k.phrase)).size, bank.length);
  assert.equal(bank.find((k) => k.phrase === "creta vs seltos")?.target_path, "/compare-cars/hyundai-creta-vs-kia-seltos");
  assert.ok(!bank.some((k) => k.target_path === "/cars/kia/seltos/mileage"), "Seltos has no mileage listed");
});
