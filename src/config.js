import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envFile = path.join(ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = (key, fallback = "") => (process.env[key] ?? fallback).trim();
const list = (key, fallback) => env(key, fallback).split(",").map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(env("PORT", "4000")),
  production: env("NODE_ENV") === "production",
  cmsUrl: env("CMS_URL", "http://localhost:4000").replace(/\/$/, ""),
  sessionSecret: env("SESSION_SECRET"),
  databaseUrl: env("DATABASE_URL"),
  seedAdmin: { email: env("SEED_ADMIN_EMAIL"), password: env("SEED_ADMIN_PASSWORD"), name: env("SEED_ADMIN_NAME", "Admin") },
  siteUrl: env("SITE_URL", "http://localhost:3001").replace(/\/$/, ""),
  revalidateSecret: env("REVALIDATE_SECRET"),
  corsOrigins: list("CORS_ORIGINS", "http://localhost:3001"),
  ai: {
    order: list("AI_PROVIDER_ORDER", "gemini,openai,claude"),
    gemini: { key: env("GEMINI_API_KEY"), model: env("GEMINI_MODEL", "gemini-flash-latest"), fallback: env("GEMINI_FALLBACK_MODEL", "gemini-flash-lite-latest") },
    openai: { key: env("OPENAI_API_KEY"), model: env("OPENAI_MODEL", "gpt-4.1-mini") },
    claude: { key: env("ANTHROPIC_API_KEY"), model: env("ANTHROPIC_MODEL", "claude-opus-5-5") },
  },
  openChargeMapKey: env("OPENCHARGEMAP_API_KEY"),
  userAgent: env("HTTP_USER_AGENT", "WheeloraCMS/1.0"),
  schedulerEnabled: env("SCHEDULER_ENABLED", "true") === "true",
  uploadDir: path.resolve(ROOT, env("UPLOAD_DIR", "uploads")),
  // Supabase Storage for images (required on Vercel, which has no disk). Empty: the uploads folder is used.
  storage: { url: env("SUPABASE_URL").replace(/\/$/, ""), key: env("SUPABASE_SERVICE_KEY"), bucket: env("SUPABASE_BUCKET", "uploads") },
  scraper: { url: env("SCRAPER_API_URL", "http://localhost:4100").replace(/\/$/, ""), token: env("SCRAPER_ADMIN_TOKEN") },
  // CarScrapper tab: the Python script in ../cardekho and the Python that runs it.
  carScraper: { python: env("CARSCRAPER_PYTHON", "python"), script: path.resolve(ROOT, env("CARSCRAPER_SCRIPT", "../cardekho/scrape.py")) },
};

export function assertConfig() {
  const missing = ["DATABASE_URL", "SESSION_SECRET"].filter((k) => !env(k));
  if (missing.length) throw new Error(`Missing settings in .env: ${missing.join(", ")}`);
}
