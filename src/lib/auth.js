import { randomBytes, timingSafeEqual } from "node:crypto";

export function requireLogin(req, res, next) {
  if (req.session?.user) return next();
  if (req.accepts(["html", "json"]) === "json" || req.xhr) return res.status(401).json({ error: "Please sign in again." });
  return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
}

export function requireAdmin(req, res, next) {
  if (req.session?.user?.role === "admin") return next();
  return res.status(403).render("error", { title: "Admins only", message: "Only an admin can open this page." });
}

export function csrfToken(req) {
  req.session.csrf ??= randomBytes(24).toString("hex");
  return req.session.csrf;
}

// Every form and fetch from the CMS carries the session's token; requests without it are refused.
export function verifyCsrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  // Multipart uploads are parsed after this check, so their forms send the token in the URL.
  const sent = String(req.body?._csrf ?? req.get("x-csrf-token") ?? req.query?._csrf ?? "");
  const want = String(req.session?.csrf ?? "");
  if (want && sent.length === want.length && timingSafeEqual(Buffer.from(sent), Buffer.from(want))) return next();
  return res.status(403).render("error", { title: "Form expired", message: "This form was open too long or came from another site. Go back, refresh the page and try again." });
}

// Simple in-memory limiter for the login form: 8 tries per 15 minutes per IP.
const tries = new Map();
export function loginLimiter(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const list = (tries.get(key) ?? []).filter((t) => now - t < 15 * 60 * 1000);
  if (list.length >= 8) return res.status(429).render("login", { error: "Too many attempts. Wait 15 minutes and try again.", next: "/admin", email: "", layout: false });
  list.push(now);
  tries.set(key, list);
  next();
}
export const clearLoginTries = (ip) => tries.delete(ip);
