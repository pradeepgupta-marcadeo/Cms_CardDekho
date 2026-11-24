// Tracks background jobs (imports, news fetches, AI batches) so the CMS can show progress.
import { one, query } from "../db.js";

const running = new Map();

export async function startRun(kind, fn) {
  if ([...running.values()].includes(kind)) {
    const existing = await one("SELECT id FROM import_runs WHERE kind = $1 AND status = 'running' ORDER BY id DESC LIMIT 1", [kind]);
    if (existing) return existing.id;
  }
  const { id } = await one("INSERT INTO import_runs (kind) VALUES ($1) RETURNING id", [kind]);
  running.set(id, kind);
  const lines = [];
  const log = (line) => {
    lines.push(`${new Date().toLocaleTimeString("en-IN", { hour12: false })}  ${line}`);
    void query("UPDATE import_runs SET log = $2 WHERE id = $1", [id, lines.join("\n")]);
  };
  (async () => {
    try {
      const summary = await fn(log);
      log("Done.");
      await query("UPDATE import_runs SET status = 'done', summary = $2, log = $3, finished_at = now() WHERE id = $1", [id, JSON.stringify(summary ?? {}), lines.join("\n")]);
    } catch (err) {
      log(`Failed: ${err.message}`);
      await query("UPDATE import_runs SET status = 'failed', log = $2, finished_at = now() WHERE id = $1", [id, lines.join("\n")]);
    } finally {
      running.delete(id);
    }
  })();
  return id;
}

// Runs a job and waits for it (used by the scheduler).
export async function runNow(kind, fn) {
  const id = await startRun(kind, fn);
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = await one("SELECT status FROM import_runs WHERE id = $1", [id]);
    if (r?.status !== "running") return id;
  }
  return id;
}
