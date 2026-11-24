// Forgiving matching for what an editor types into the CarScrapper boxes: any case, extra spaces or dashes, other
// names ("Maruti Suzuki", "Merc", "VW") and small typos all find the right brand. Cities are matched by scrape.py
// (it has CarDekho's full city list); see run_resolve_cities there.

/** "  Mercedes Benz " -> "mercedes benz"; "land-rover" -> "land rover". */
export const normName = (s) => String(s ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

const BRAND_ALIASES = {
  "maruti suzuki": "maruti", suzuki: "maruti", "mercedes": "mercedes-benz", "mercedes benz": "mercedes-benz", benz: "mercedes-benz",
  merc: "mercedes-benz", "range rover": "land-rover", "rolls": "rolls-royce", vw: "volkswagen", "mg motor": "mg", "morris garages": "mg",
  "mahindra and mahindra": "mahindra", "m and m": "mahindra", "tata motors": "tata", "aston": "aston-martin", "lambo": "lamborghini",
};

/** Edit distance (number of single-letter changes), for small typos. */
export function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

/**
 * Finds the brand for whatever was typed. brands: [{ slug: "mercedes-benz", name: "Mercedes-Benz" }].
 * Returns { brand, suggestions }: brand is null when nothing is close enough.
 */
export function matchBrand(text, brands) {
  const q = normName(text);
  if (!q) return { brand: null, suggestions: [] };
  const keyed = brands.map((b) => ({ b, keys: [normName(b.slug), normName(b.name)] }));
  const alias = BRAND_ALIASES[q];
  const exact = keyed.find(({ b, keys }) => keys.includes(q) || b.slug === alias || keys.includes(q.replace(/ /g, "")) || keys.some((k) => k.replace(/ /g, "") === q.replace(/ /g, "")));
  if (exact) return { brand: exact.b, suggestions: [] };
  const scored = keyed
    .map(({ b, keys }) => ({ b, d: Math.min(...keys.map((k) => distance(q, k))), starts: keys.some((k) => k.startsWith(q) && q.length >= 3) }))
    .sort((x, y) => Number(y.starts) - Number(x.starts) || x.d - y.d);
  const best = scored[0];
  const allowed = q.length <= 4 ? 1 : 2;
  if (best && (best.starts || best.d <= allowed) && !(scored[1] && scored[1].starts && best.starts && scored[1].b !== best.b && q.length < 4)) return { brand: best.b, suggestions: [] };
  return { brand: null, suggestions: scored.filter((s) => s.d <= 4).slice(0, 3).map((s) => s.b.name) };
}
