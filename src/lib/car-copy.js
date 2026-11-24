// AI copy for every car page on the website: summary, verdict, angle, pros, cons, a short buying guide and FAQs,
// each written in our own words from the car's data and from CarDekho's expert review (research only, never copied).
// Checks before saving: the text may not repeat the research (8-word runs, like the news writer) nor another car's
// copy; it is rewritten once, then written from the data alone. Cars whose data did not change are skipped.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { rows, query } from "../db.js";
import { writeCarCopy } from "./ai-writer.js";
import { fixDraft, nameFixer } from "./casing.js";
import { carFacts } from "./drafts.js";
import { carUrl, pickForPath } from "./keywords.js";
import { OVERLAP_LIMIT, overlapPercent, sameText } from "./news-text.js";
import { contentChanged } from "./publish.js";
import { buildSnapshot } from "./snapshot.js";

/** CarDekho's review of one car (pros, cons, verdict, sections): newest of the --reviews file and the saved car data. */
function reviewsFrom(dataDir) {
  const out = new Map();
  const file = path.join(dataDir, "reviews.jsonl");
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const r = JSON.parse(line);
      if (r?.slug) out.set(r.slug, r);
    } catch {
      // a half-written line is skipped
    }
  }
  return out;
}

/** The research notes as plain text (about 6,000 characters at most), and all of it for the overlap check. */
export function researchText(r) {
  if (!r) return { notes: "", all: "" };
  const parts = [
    r.pros?.length ? `Strengths reviewers point out: ${r.pros.join(" | ")}` : "",
    r.cons?.length ? `Weak points reviewers point out: ${r.cons.join(" | ")}` : "",
    r.verdict ? `Reviewer verdict: ${r.verdict}` : "",
    ...(r.review_sections ?? r.expert_review ?? []).filter((s) => s?.text && !/verdict/i.test(s.title ?? "")).map((s) => `${s.title}${s.rating ? ` (rated ${s.rating}/5)` : ""}: ${s.text}`),
  ].filter(Boolean);
  const all = parts.join("\n");
  return { notes: all.length > 6000 ? `${all.slice(0, 6000)}...` : all, all };
}

const copyText = (c) => [c.summary, c.verdict, c.angle, ...c.pros, ...c.cons, ...c.sections.flatMap((s) => [s.h, ...s.p]), ...c.faqs.flatMap((f) => [f.q, f.a])].join(" ");

/**
 * Writes the copy of the website's cars. opts: { brand, limit, refresh (write again even if unchanged), onlyNew
 * (only cars that have no copy yet: used after every scrape) }.
 */
export async function writeCarCopies(ctx, dataDir, { brand = null, limit = null, refresh = false, onlyNew = false } = {}) {
  const snap = await buildSnapshot();
  const live = new Set(snap.cars.map((c) => c.key));
  const cars = (
    await rows(
      `SELECT c.id, c.name, c.slug, c.copy, c.overview, c.source, b.slug AS brand_slug, b.name AS brand, d.data AS cd
       FROM cars c JOIN brands b ON b.id = c.brand_id LEFT JOIN cardekho_cars d ON d.slug = c.source->>'cardekhoSlug'
       WHERE c.published AND ($1::text IS NULL OR b.slug = $1) ORDER BY c.popularity DESC, c.name`,
      [brand],
    )
  ).filter((c) => live.has(`${c.brand_slug}-${c.slug}`));
  const reviews = reviewsFrom(dataDir);
  const kwRows = await rows("SELECT phrase, priority, target_path FROM keywords WHERE target_path LIKE '/cars/%'");
  const fix = await nameFixer();
  const todo = [];
  for (const c of cars) {
    if (onlyNew && c.copy) continue;
    const slug = c.source?.cardekhoSlug;
    const fromScrape = c.cd && (c.cd.pros?.length || c.cd.verdict || c.cd.review_sections?.length) ? c.cd : null;
    const fromFile = slug ? reviews.get(slug) : null;
    const research = researchText(fromFile ?? fromScrape ?? (c.cd?.expert_review?.length ? { expert_review: c.cd.expert_review } : null));
    const base = carUrl({ brandSlug: c.brand_slug, slug: c.slug });
    // The overview page's phrases first, then the strongest phrases of the car's other pages.
    const own = pickForPath(kwRows, base);
    const others = kwRows.filter((k) => k.target_path.startsWith(`${base}/`) && k.priority !== "long-tail" && !k.target_path.includes("/variants/") && !k.target_path.includes("/price-in-")).map((k) => k.phrase);
    const primary = own.primary || `${c.brand} ${c.name}`.toLowerCase();
    // "alcazar car" is a real search but reads badly in a sentence; it stays on the page title only.
    const secondary = [...new Set([...own.secondary, ...others])].filter((k) => k !== primary && !/ car$/.test(k)).slice(0, 14);
    // Our own earlier pros and cons are left out, so writing them does not count as a change next time.
    let facts = ((await carFacts(c.id))?.text ?? "").split("\n").filter((l) => !/^Known (strengths|weak points):/.test(l)).join("\n");
    // Seat layouts from the variant sheets ("6, 7"): the model page sometimes lists only one.
    const layouts = slug ? (await rows("SELECT DISTINCT seats FROM cardekho_variants WHERE car_slug = $1 AND seats > 0 ORDER BY seats", [slug])).map((r) => r.seats) : [];
    if (layouts.length > 1) facts += `
Seating layouts by variant: ${layouts.join(", ")} seats`;
    const hash = createHash("sha1").update(`${facts}\n${research.all}\n${primary}`).digest("hex").slice(0, 16);
    if (!refresh && c.copy?.hash === hash) continue;
    todo.push({ c, research, primary, secondary, facts, hash });
  }
  const list = limit ? todo.slice(0, limit) : todo;
  ctx.log(`${cars.length} cars on the website, ${cars.length - todo.length} already written and unchanged, ${list.length} to write.`);
  const others = (await rows("SELECT id, name, copy, pros, cons, overview, faqs FROM cars WHERE copy IS NOT NULL")).map((o) => ({ id: o.id, text: copyText({ ...o.copy, pros: o.pros ?? [], cons: o.cons ?? [], sections: o.overview ?? [], faqs: o.faqs ?? [] }) }));
  const tally = { NEW: 0, UPDATED: 0, failed: 0 };
  for (const [i, job] of list.entries()) {
    if (ctx.stopped()) break;
    const { c, research, primary, secondary, facts, hash } = job;
    const full = c.name.toLowerCase().startsWith(`${c.brand.toLowerCase()} `) ? c.name : `${c.brand} ${c.name}`; // "MG Hector", not "MG MG Hector"
    const tag = `[${i + 1}/${list.length}] ${full}`;
    ctx.progress(i, list.length);
    try {
      const write = (extra = "", withResearch = true) => writeCarCopy({ facts, primary, secondary, research: withResearch ? research.notes : "", extra });
      let copy = fixDraft(fix, await write());
      copy = { ...copy, summary: fix(copy.summary), verdict: fix(copy.verdict) };
      const check = (cp) => {
        const text = copyText(cp);
        const lifted = research.all ? overlapPercent(text, research.all) : 0;
        const twin = others.find((o) => o.id !== c.id && sameText(text, o.text));
        return { text, lifted, twin };
      };
      let res = check(copy);
      if (res.lifted > OVERLAP_LIMIT || res.twin) {
        ctx.log(`${tag} | ${res.lifted > OVERLAP_LIMIT ? `${res.lifted.toFixed(1)}% matched the research` : "read too much like another car's page"} - writing again`);
        copy = fixDraft(fix, await write("Your last attempt reused wording from the research notes or from other car pages. Write every sentence fresh; never more than five words in a row from the notes."));
        copy = { ...copy, summary: fix(copy.summary), verdict: fix(copy.verdict) };
        res = check(copy);
        if (res.lifted > OVERLAP_LIMIT || res.twin) {
          ctx.log(`${tag} | still too close - writing from the car's data only`);
          copy = fixDraft(fix, await write("", false));
          copy = { ...copy, summary: fix(copy.summary), verdict: fix(copy.verdict) };
          res = check(copy);
        }
      }
      if (!copy.summary || copy.pros.length < 2 || copy.cons.length < 1 || res.twin) throw new Error(res.twin ? "the copy repeats another car's page" : "the AI answer was incomplete");
      await query(
        `UPDATE cars SET angle = COALESCE(NULLIF($2, ''), angle), pros = $3, cons = $4, overview = $5, faqs = $6,
           copy = $7, updated_at = now() WHERE id = $1`,
        [c.id, copy.angle, copy.pros, copy.cons, JSON.stringify(copy.sections), JSON.stringify(copy.faqs), JSON.stringify({ summary: copy.summary, verdict: copy.verdict, hash, keyword: primary, ai: copy.provider, research: Boolean(research.all), lifted: Number(res.lifted.toFixed(2)), at: new Date().toISOString() })],
      );
      others.push({ id: c.id, text: res.text });
      const kind = c.copy ? "UPDATED" : "NEW";
      tally[kind] += 1;
      ctx.change(`${tag} | summary, verdict, ${copy.pros.length} pros, ${copy.cons.length} cons, ${copy.sections.length} guide sections, ${copy.faqs.length} FAQs | keyword "${primary}" | ${res.lifted.toFixed(1)}% overlap with research | ${kind}`);
      await contentChanged();
    } catch (err) {
      tally.failed += 1;
      ctx.log(`${tag} | not written: ${String(err.message).slice(0, 160)}`);
    }
  }
  ctx.progress(list.length, list.length);
  ctx.log(`Car pages: ${tally.NEW} written, ${tally.UPDATED} rewritten, ${tally.failed} failed.`);
  return tally;
}

/**
 * Car guides that are CarDekho's own review text (the site used to fill them in from it word for word): emptied,
 * so the page shows our own copy only. Returns how many were cleared.
 */
export async function clearCopiedGuides(overviewFrom) {
  const list = await rows("SELECT c.id, c.overview, d.data->'expert_review' AS review FROM cars c JOIN cardekho_cars d ON d.slug = c.source->>'cardekhoSlug' WHERE c.copy IS NULL AND jsonb_typeof(c.overview) = 'array' AND jsonb_array_length(c.overview) > 0");
  let n = 0;
  for (const c of list) {
    if (JSON.stringify(c.overview) === JSON.stringify(overviewFrom(c.review ?? []))) {
      await query("UPDATE cars SET overview = '[]'::jsonb, updated_at = now() WHERE id = $1", [c.id]);
      n += 1;
    }
  }
  if (n) await contentChanged();
  return n;
}
