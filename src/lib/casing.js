// Keywords are stored in lowercase, and AI writers often paste them in as is
// ("toyota fortuner launch"). This restores the proper spelling of every brand
// and model name the site knows, wherever it appears in a draft.
import { rows } from "../db.js";
import { escapeRegExp } from "./text.js";

// Model names that are also everyday words ("city runs", "a new venue"): fixed only right after their brand.
const COMMON = new Set(["city", "venue", "aura", "kicks", "compass", "elevate", "amaze", "seal", "dolphin", "comet", "windsor", "glance", "style", "plus", "cross", "one", "go", "jazz", "brio", "life", "ignis"]);

export async function nameFixer() {
  const list = await rows("SELECT b.name AS brand, c.name FROM cars c JOIN brands b ON b.id = c.brand_id UNION SELECT name, NULL FROM brands");
  const res = [];
  for (const r of list) {
    const n = r.name ?? r.brand;
    if (!n || n.length <= 2 || !/[A-Z]/.test(n)) continue;
    if (r.name && COMMON.has(n.toLowerCase())) res.push([new RegExp(`\\b${escapeRegExp(r.brand)}\\s+${escapeRegExp(n)}\\b`, "gi"), `${r.brand} ${n}`, n.length + r.brand.length]);
    else res.push([new RegExp(`\\b${escapeRegExp(n)}\\b`, "gi"), n, n.length]);
  }
  // Longest first, so "Grand Vitara" wins over "Vitara".
  res.sort((a, b) => b[2] - a[2]);
  return (text) => res.reduce((t, [re, n]) => t.replace(re, n), String(text ?? ""));
}

/** Applies the fixer to every text field of a draft or car copy. */
export function fixDraft(fix, d) {
  const sec = (list) =>
    (list ?? []).map((s) => ({
      ...s,
      h: fix(s.h),
      p: (s.p ?? []).map(fix),
      ...(s.bullets ? { bullets: s.bullets.map(fix) } : {}),
      ...(s.steps ? { steps: s.steps.map(fix) } : {}),
      ...(s.table ? { table: { head: s.table.head.map(fix), rows: s.table.rows.map((r) => r.map(fix)) } } : {}),
    }));
  return {
    ...d,
    title: d.title !== undefined ? fix(d.title) : d.title,
    seoTitle: d.seoTitle !== undefined ? fix(d.seoTitle) : d.seoTitle,
    seoDescription: d.seoDescription !== undefined ? fix(d.seoDescription) : d.seoDescription,
    excerpt: d.excerpt !== undefined ? fix(d.excerpt) : d.excerpt,
    angle: d.angle !== undefined ? fix(d.angle) : d.angle,
    pros: d.pros?.map(fix),
    cons: d.cons?.map(fix),
    sections: sec(d.sections),
    faqs: (d.faqs ?? []).map((f) => ({ q: fix(f.q), a: fix(f.a) })),
  };
}
