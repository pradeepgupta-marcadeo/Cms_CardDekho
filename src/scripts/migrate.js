// Creates the database if needed, then applies every SQL file in src/migrations once.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { ROOT, assertConfig, config } from "../config.js";

assertConfig();

async function ensureDatabase() {
  const url = new URL(config.databaseUrl);
  const name = url.pathname.replace(/^\//, "");
  url.pathname = "/postgres";
  url.search = "";
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (!exists.rowCount) {
    await admin.query(`CREATE DATABASE "${name.replace(/"/g, "")}"`);
    console.log(`Created database ${name}`);
  }
  await admin.end();
}

async function migrate() {
  await ensureDatabase();
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const dir = path.join(ROOT, "src", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    await client.query("BEGIN");
    try {
      await client.query(readFileSync(path.join(dir, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`Applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }
  await client.end();
  console.log("Database is up to date.");
}

migrate().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
