// Official daily petrol and diesel prices from PPAC (Petroleum Planning &
// Analysis Cell, Government of India). PPAC publishes the four metros only, so
// other cities keep the prices an editor enters by hand.
import { extractText, getDocumentProxy } from "unpdf";
import { query, rows } from "../db.js";
import { fetchWithRetry, getText } from "../lib/http.js";

const PAGE = "https://ppac.gov.in/retail-selling-price-rsp-of-petrol-diesel-and-domestic-lpg/rsp-of-petrol-and-diesel-in-metro-cities-since-16-6-2017";
const METROS = ["Delhi", "Mumbai", "Chennai", "Kolkata"];
const CITY_FOR = { Delhi: ["new-delhi", "delhi"], Mumbai: ["mumbai"], Chennai: ["chennai"], Kolkata: ["kolkata"] };
const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

// First table row looks like: "12-Nov-26 102.12 111.21 107.77 113.51 12-Nov-26 95.20 97.83 99.55 99.82"
export function parsePpac(text) {
  const m = text.match(/(\d{1,2})-(\w{3})-(\d{2})\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+\d{1,2}-\w{3}-\d{2}\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (!m) throw new Error("Could not find the price table in the PPAC file.");
  const date = `20${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, "0")}`;
  const petrol = m.slice(4, 8).map(Number);
  const diesel = m.slice(8, 12).map(Number);
  return { date, prices: METROS.map((city, i) => ({ city, petrol: petrol[i], diesel: diesel[i] })) };
}

/** Today's PPAC metro prices: { date, prices: [{ city, petrol, diesel }] }. */
export async function fetchPpac() {
  const html = await getText(PAGE, { timeout: 30000 });
  const pdfUrl = html.match(/href="([^"]*DailyPrice[^"]*Metro[^"]*\.pdf)"/i)?.[1];
  if (!pdfUrl) throw new Error("PPAC page did not link a daily metro price file.");
  const res = await fetchWithRetry(new URL(pdfUrl, PAGE).toString(), { timeout: 60000 });
  if (!res.ok) throw new Error(`PPAC file: ${res.status}`);
  const pdf = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
  const { text } = await extractText(pdf, { mergePages: true });
  return parsePpac(text);
}

/** Which PPAC metro (if any) a CMS city slug belongs to. */
export const ppacMetroFor = (slug) => Object.keys(CITY_FOR).find((m) => CITY_FOR[m].includes(slug)) ?? null;

export async function runPpac({ log = () => {} } = {}) {
  const { date, prices } = await fetchPpac();
  log(`PPAC prices dated ${date}.`);
  const cities = await rows("SELECT id, slug, name FROM cities");
  const updated = [];
  for (const p of prices) {
    const city = cities.find((c) => CITY_FOR[p.city].includes(c.slug));
    if (!city) continue;
    await query(
      `INSERT INTO fuel_prices (city_id, petrol, diesel, price_date, source, is_demo) VALUES ($1,$2,$3,$4,'PPAC (Government of India)',false)
       ON CONFLICT (city_id) DO UPDATE SET petrol = EXCLUDED.petrol, diesel = EXCLUDED.diesel, price_date = EXCLUDED.price_date, source = EXCLUDED.source, is_demo = false, updated_at = now()`,
      [city.id, p.petrol, p.diesel, date],
    );
    updated.push(`${city.name}: petrol Rs ${p.petrol}, diesel Rs ${p.diesel}`);
  }
  log(updated.length ? `Updated ${updated.join("; ")}.` : "None of the PPAC metros are in your city list.");
  return { date, updated, skipped: METROS.filter((m) => !updated.some((u) => u.startsWith(m) || (m === "Delhi" && u.startsWith("New Delhi")))) };
}
