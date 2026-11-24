import pg from "pg";
import { config } from "./config.js";

// NUMERIC columns arrive as strings by default; prices and rates are small enough for floats.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// DATE columns stay as plain YYYY-MM-DD strings, so no time zone shifts them.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export const query = (text, params = []) => pool.query(text, params);
export const rows = async (text, params = []) => (await pool.query(text, params)).rows;
export const one = async (text, params = []) => (await pool.query(text, params)).rows[0] ?? null;

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getSetting(key, fallback = null) {
  const row = await one("SELECT value FROM settings WHERE key = $1", [key]);
  return row ? row.value : fallback;
}

export async function setSetting(key, value, client = pool) {
  await client.query(
    "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    [key, JSON.stringify(value)],
  );
}
