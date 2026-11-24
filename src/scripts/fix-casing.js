// Restores brand and model capitalisation in AI-written drafts and car copy.
import { pool, query, rows } from "../db.js";
import { fixDraft, nameFixer } from "../lib/casing.js";

const fix = await nameFixer();
for (const a of await rows("SELECT id, title, excerpt, body, seo FROM articles WHERE ai_generated")) {
  const d = fixDraft(fix, { title: a.title, excerpt: a.excerpt, sections: a.body, seoTitle: a.seo?.title ?? "", seoDescription: a.seo?.description ?? "", faqs: a.seo?.faqs ?? [] });
  await query("UPDATE articles SET title = $2, excerpt = $3, body = $4, seo = seo || $5::jsonb WHERE id = $1", [a.id, d.title, d.excerpt, JSON.stringify(d.sections), JSON.stringify({ title: d.seoTitle, description: d.seoDescription, faqs: d.faqs })]);
}
for (const c of await rows("SELECT id, angle, pros, cons, overview, faqs FROM cars WHERE jsonb_array_length(overview) > 0")) {
  const d = fixDraft(fix, { angle: c.angle, pros: c.pros, cons: c.cons, sections: c.overview, faqs: c.faqs });
  await query("UPDATE cars SET angle = $2, pros = $3, cons = $4, overview = $5, faqs = $6 WHERE id = $1", [c.id, d.angle, d.pros, d.cons, JSON.stringify(d.sections), JSON.stringify(d.faqs)]);
}
console.log("Fixed casing.");
await pool.end();
