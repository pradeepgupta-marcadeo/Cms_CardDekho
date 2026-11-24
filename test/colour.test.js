import assert from "node:assert/strict";
import { test } from "node:test";
import { colourFromText, familiesOfColour, wordsFromCommonsPage } from "../src/lib/colour-detect.js";

const palette = [
  { name: "Pearl White", hex: "#F4F4F0" },
  { name: "Fiery Red", hex: "#B11226" },
  { name: "Titan Grey", hex: "#6B6F73" },
  { name: "Abyss Black", hex: "#0B0B0D" },
  { name: "Ocean Blue", hex: "#1E4DA1" },
];

test("a colour is chosen from the words around a photo only when exactly one colour fits", () => {
  assert.equal(colourFromText("Hyundai Creta red front", palette), "Fiery Red");
  assert.equal(colourFromText("Creta in white at an auto expo", palette), "Pearl White");
  assert.equal(colourFromText("Hyundai Creta red and blue", palette), null);
  assert.equal(colourFromText("Hyundai Creta front view", palette), null);
});

test("two palette colours of the same family make the match ambiguous", () => {
  const two = [...palette, { name: "Scarlet Red", hex: "#C1121F" }];
  assert.equal(colourFromText("Creta red", two), null);
});

test("a colour with no colour word in its name is classed by its hex value", () => {
  assert.deepEqual([...familiesOfColour({ name: "Atlas", hex: "#1E4DA1" })], ["blue"]);
});

test("a Commons page address becomes plain words", () => {
  assert.equal(wordsFromCommonsPage("https://commons.wikimedia.org/wiki/File:Hyundai_Creta_Red_2024.jpg").trim().replace(/\s+/g, " "), "Hyundai Creta Red");
});
