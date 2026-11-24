// Talks to the automotive scraper service (../automotive-scraper) server to
// server with its admin token. The token never reaches the browser.
import { config } from "../config.js";

export class ScraperUnavailable extends Error {}

export async function scraper(path, { method = "GET", body, timeout = 30000 } = {}) {
  if (!config.scraper.token) throw new ScraperUnavailable("SCRAPER_ADMIN_TOKEN is not set in cms_cardekho/.env.");
  let res;
  try {
    res = await fetch(`${config.scraper.url}/api/scraper${path}`, {
      method,
      headers: { authorization: `Bearer ${config.scraper.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new ScraperUnavailable(`The scraper service is not reachable at ${config.scraper.url} (${err.cause?.code ?? err.message}). Start it with "npm start" in automotive-scraper.`);
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error ? `${data.error}${data.details ? `: ${data.details.map((d) => `${d.path} ${d.message}`).join("; ")}` : ""}` : `Scraper answered ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

/** Downloads a file the scraper stored (only licensed images are stored there). */
export const scraperMediaUrl = (u) => (u && u.startsWith(config.scraper.url) ? u : null);
