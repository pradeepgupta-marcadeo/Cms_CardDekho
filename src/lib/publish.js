// After any change: record who did it, bump the content version, and tell the
// website to refresh. Several saves in quick succession send one refresh.
import { config } from "../config.js";
import { query, setSetting } from "../db.js";
import { invalidateSnapshot } from "./snapshot.js";

let timer = null;
let lastResult = { ok: null, at: null, message: "No refresh sent yet." };
export const lastRefresh = () => lastResult;

export async function notifyWebsite() {
  if (!config.revalidateSecret) {
    lastResult = { ok: false, at: new Date(), message: "REVALIDATE_SECRET is not set in .env." };
    return lastResult;
  }
  try {
    const res = await fetch(`${config.siteUrl}/api/revalidate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-revalidate-secret": config.revalidateSecret },
      body: JSON.stringify({ tag: "cms" }),
      signal: AbortSignal.timeout(8000),
    });
    lastResult = { ok: res.ok, at: new Date(), message: res.ok ? "Website refreshed." : `Website answered ${res.status}.` };
    // Visit the home page once so it re-renders now, not on a reader's first visit.
    if (res.ok) void fetch(`${config.siteUrl}/`, { signal: AbortSignal.timeout(15000) }).catch(() => {});
  } catch (err) {
    lastResult = { ok: false, at: new Date(), message: `Website not reachable at ${config.siteUrl} (${err.cause?.code ?? err.message}). It will pick up the change when it next starts.` };
  }
  return lastResult;
}

export async function contentChanged() {
  await setSetting("content_version", Date.now());
  invalidateSnapshot();
  clearTimeout(timer);
  timer = setTimeout(() => void notifyWebsite(), 1200);
}

export async function audit(req, action, entity, entityId = null, detail = "") {
  await query("INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)", [req?.session?.user?.id ?? null, action, entity, entityId === null ? null : String(entityId), detail.slice(0, 500)]);
}
