// Works out which of a car's colours a photograph shows. Two sources, and neither guesses:
//   1. the words around the photo (file name, description, categories): "Creta red" -> the red colour;
//   2. the pixels of the car's body, but only when the car is vividly coloured (red, blue, green ...).
//      A white, black or silver car cannot be told apart from its surroundings by pixels, so those
//      photos stay untagged and an editor sets the colour on the car's Photos screen.
// A colour is returned only when exactly one of the car's colours fits. Otherwise null.
import sharp from "sharp";

const WORDS = {
  white: /\b(white|pearl|ivory|polar|arctic|glacier|alabaster|snow)\b/,
  black: /\b(black|obsidian|onyx|ebony|jet|phantom|carbon)\b/,
  grey: /\b(gr[ae]y|silver|titan|graphite|gunmetal|steel|ash|slate|charcoal)\b/,
  red: /\b(red|crimson|maroon|ruby|fiery|scarlet|burgundy|wine|cherry)\b/,
  blue: /\b(blue|navy|cobalt|azure|sapphire|teal|cyan|aqua|indigo)\b/,
  green: /\b(green|emerald|olive|forest|mint|jade)\b/,
  orange: /\b(orange|copper|amber|tangerine|sunset|flame)\b/,
  yellow: /\b(yellow|gold|golden|mustard|lemon|champagne)\b/,
  brown: /\b(brown|bronze|coffee|chocolate|mocha|beige|cappuccino|khaki)\b/,
  purple: /\b(purple|violet|plum|lavender|magenta|pink)\b/,
};
export const FAMILIES = Object.keys(WORDS);

/** [hue 0-360, saturation 0-1, lightness 0-1] of an RGB colour. */
export function hsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return [h, s, l];
}

/** The family a hue/saturation/lightness belongs to. */
export function familyOfHsl([h, s, l]) {
  if (l > 0.86 && s < 0.2) return "white";
  if (l < 0.14) return "black";
  if (s < 0.14) return "grey";
  if ((h < 40 || h >= 345) && l < 0.35 && h >= 10 && h < 40) return "brown";
  if (h >= 345 || h < 15) return "red";
  if (h < 40) return "orange";
  if (h < 65) return l < 0.4 ? "brown" : "yellow";
  if (h < 170) return "green";
  if (h < 260) return "blue";
  return "purple";
}

/** Families named in a piece of text (colour words), as a Set. */
export function familiesInText(text) {
  const t = String(text ?? "").toLowerCase();
  return new Set(FAMILIES.filter((f) => WORDS[f].test(t)));
}

/** The family set of a palette colour: its name's words first, else its hex value. */
export function familiesOfColour(c) {
  const named = familiesInText(c.name);
  if (named.size) return named;
  const m = /^#?([0-9a-f]{6})$/i.exec(c.hex ?? "");
  if (!m) return new Set();
  const n = parseInt(m[1], 16);
  return new Set([familyOfHsl(hsl((n >> 16) & 255, (n >> 8) & 255, n & 255))]);
}

/** The one palette colour that matches `family`, preferring plain single-colour names; else null. */
function onlyColourFor(family, palette) {
  const fits = palette.map((c) => ({ c, fam: familiesOfColour(c) })).filter((x) => x.fam.has(family));
  const plain = fits.filter((x) => x.fam.size === 1);
  const pool = plain.length ? plain : fits;
  return pool.length === 1 ? pool[0].c.name : null;
}

/** Colour from the words around a photo. */
export function colourFromText(text, palette) {
  const found = familiesInText(text);
  return found.size === 1 ? onlyColourFor([...found][0], palette) : null;
}

/** Colour from the car body's pixels, for vividly coloured cars only. */
export async function colourFromPixels(buffer, palette) {
  try {
    const { data, info } = await sharp(buffer).resize(96, 64, { fit: "cover" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const tally = {};
    let box = 0;
    let vivid = 0;
    for (let y = Math.floor(info.height * 0.4); y < Math.floor(info.height * 0.78); y++) {
      for (let x = Math.floor(info.width * 0.3); x < Math.floor(info.width * 0.7); x++) {
        const i = (y * info.width + x) * 3;
        const [h, s, l] = hsl(data[i], data[i + 1], data[i + 2]);
        box++;
        if (s > 0.5 && l > 0.2 && l < 0.78) {
          const f = familyOfHsl([h, s, l]);
          tally[f] = (tally[f] ?? 0) + 1;
          vivid++;
        }
      }
    }
    if (!box || vivid / box < 0.45) return null;
    const [top, n] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] ?? [];
    if (!top || n / vivid < 0.8) return null;
    return onlyColourFor(top, palette);
  } catch {
    return null;
  }
}

/** The file name a Commons page URL points at, as readable words. */
export const wordsFromCommonsPage = (page) => {
  const name = decodeURIComponent(String(page ?? "").split("File:")[1] ?? "");
  return name.replace(/\.[a-z]{3,4}$/i, "").replace(/[_\-.()0-9]+/g, " ");
};
