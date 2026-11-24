// Runs one CarScrapper job (a row in import_runs) in its own process, so it keeps going when the CMS restarts.
// Started by src/lib/carscraper.js (startScrape):   node src/scripts/carscraper-worker.js <run id>
import { pool, query } from "../db.js";
import { runWorker } from "../lib/carscraper.js";

const id = Number(process.argv[2]);
try {
  if (!id) throw new Error("Give the run id.");
  await runWorker(id);
} catch (err) {
  await query("UPDATE import_runs SET status = 'failed', finished_at = now(), log = log || $2 WHERE id = $1 AND status = 'running'", [id, `\nFailed: ${err.message}`]).catch(() => {});
}
// Give the debounced website refresh time to fire, then leave.
await new Promise((r) => setTimeout(r, 3000));
await pool.end().catch(() => {});
process.exit(0);
