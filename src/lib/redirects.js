import { query } from "../db.js";

// Adds old -> new and keeps every redirect a single hop (guardrails): anything
// that pointed at the old URL now points straight at the new one, and a
// redirect *from* the new URL (which would loop) is removed.
export async function addRedirect(source, destination, { onlyIfMissing = false } = {}) {
  if (!source || !destination || source === destination) return;
  await query("DELETE FROM redirects WHERE source = $1", [destination]);
  await query("UPDATE redirects SET destination = $2 WHERE destination = $1", [source, destination]);
  await query(
    onlyIfMissing
      ? "INSERT INTO redirects (source, destination) VALUES ($1, $2) ON CONFLICT (source) DO NOTHING"
      : "INSERT INTO redirects (source, destination) VALUES ($1, $2) ON CONFLICT (source) DO UPDATE SET destination = EXCLUDED.destination",
    [source, destination],
  );
}
