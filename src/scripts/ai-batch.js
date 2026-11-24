// Writes AI content in bulk, one item at a time (the AI APIs rate-limit bursts):
//   node src/scripts/ai-batch.js cars 8        buying guide, pros/cons and FAQs for the 8 most popular cars without one
//   node src/scripts/ai-batch.js news 5        drafts from the 5 newest news leads that name a car on the site
// News drafts are saved unpublished; car copy goes live (edit it in the CMS if needed).
import { pool, rows } from "../db.js";
import { draftFromLead, writeCarPageCopy } from "../lib/drafts.js";

const [what = "cars", n = "5"] = process.argv.slice(2);
const limit = Math.max(1, Math.min(50, Number(n) || 5));

const list =
  what === "news"
    ? await rows("SELECT l.id, l.title AS label FROM news_leads l JOIN cars c ON c.id = l.car_id WHERE l.status = 'new' AND c.published ORDER BY l.is_launch DESC, l.published_at DESC NULLS LAST LIMIT $1", [limit])
    : await rows("SELECT c.id, b.name || ' ' || c.name AS label FROM cars c JOIN brands b ON b.id = c.brand_id WHERE c.published AND jsonb_array_length(c.overview) = 0 AND EXISTS (SELECT 1 FROM photos p WHERE p.car_id = c.id) ORDER BY c.popularity DESC LIMIT $1", [limit]);

for (const item of list) {
  const t = Date.now();
  try {
    if (what === "news") {
      const id = await draftFromLead(null, item.id);
      console.log(`draft #${id} from "${item.label}" (${Math.round((Date.now() - t) / 1000)}s)`);
    } else {
      const r = await writeCarPageCopy(null, item.id);
      console.log(`${item.label}: ${r.sections.length} sections, ${r.faqs.length} FAQs via ${r.provider} (${Math.round((Date.now() - t) / 1000)}s)`);
    }
  } catch (err) {
    console.log(`${item.label}: failed (${err.message})`);
  }
}
// Give the debounced website refresh time to fire before exiting.
await new Promise((r) => setTimeout(r, 2500));
await pool.end();
