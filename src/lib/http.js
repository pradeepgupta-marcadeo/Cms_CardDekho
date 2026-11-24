import { config } from "../config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with our User-Agent, a timeout and a few retries on 429/5xx, as the
// Wikimedia, OpenStreetMap and news-feed usage policies ask.
export async function fetchWithRetry(url, { tries = 3, timeout = 20000, headers = {}, ...init } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { "user-agent": config.userAgent, ...headers }, signal: AbortSignal.timeout(timeout) });
      if (res.status === 429 || res.status >= 500) {
        last = new Error(`${res.status} from ${new URL(url).host}`);
        await sleep(1500 * (i + 1) * (res.status === 429 ? 3 : 1));
        continue;
      }
      return res;
    } catch (err) {
      last = err;
      await sleep(1000 * (i + 1));
    }
  }
  throw last;
}

export async function getJson(url, opts) {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  return res.json();
}

export async function getText(url, opts) {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  return res.text();
}
