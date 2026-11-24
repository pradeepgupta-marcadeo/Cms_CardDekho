// Checks a page against WEBSITE_GUARDRAILS.md and basic keyword use. Runs in the
// browser too (public/admin.js imports the same rules through /admin/seo-rules.js).
import { countWords, escapeRegExp, flattenSections, words } from "./text.js";

const has = (text, phrase) => phrase && new RegExp(`\\b${escapeRegExp(phrase.toLowerCase())}\\b`).test(String(text ?? "").toLowerCase());

const occurrences = (text, phrase) => {
  if (!phrase) return 0;
  const m = String(text ?? "").toLowerCase().match(new RegExp(`\\b${escapeRegExp(phrase.toLowerCase())}\\b`, "g"));
  return m ? m.length : 0;
};

/**
 * @param {{title?:string, description?:string, h1?:string, sections?:{h:string,p:string[]}[], primary?:string, secondary?:string[], minWords?:number, minSecondary?:number, titles?:string[]}} page
 */
export function checkSeo(page) {
  const title = (page.title ?? "").trim();
  const description = (page.description ?? "").trim();
  const h1 = (page.h1 ?? "").trim();
  const sections = flattenSections(page.sections);
  const primary = (page.primary ?? "").trim().toLowerCase();
  const secondary = (page.secondary ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const body = sections.map((s) => [s.h, ...(s.p ?? [])].join(" ")).join(" ");
  const firstPara = sections.find((s) => (s.p ?? []).length)?.p[0] ?? "";
  const total = countWords(sections);
  const minWords = page.minWords ?? 300;
  const checks = [];
  const add = (ok, label, hint, weight = 1) => checks.push({ ok: Boolean(ok), label, hint, weight });

  add(title.length >= 30 && title.length <= 60, `Title length ${title.length} (30–60)`, "This is the blue heading in Google search results. Keep it 30–60 characters, or it gets cut off.", 2);
  add(description.length >= 120 && description.length <= 160, `Description length ${description.length} (120–160)`, "The 2 lines under the title in search results. 120–160 characters is best.", 2);
  if (h1 || page.h1 !== undefined) {
    add(h1.length > 0, "Page has an H1 heading", "The biggest heading on the page. Every page should have one.", 2);
    add(h1 && h1.toLowerCase() !== title.toLowerCase(), "H1 is different from the title", "Guardrails: the title and H1 should not be exactly the same.");
  }
  if (page.titles?.some((t) => t.trim().toLowerCase() === title.toLowerCase())) add(false, "Title is unique on the site", "Another page also has this title. Give every page a different title.", 2);
  if (sections.length) {
    add(total >= minWords, `Word count ${total} (at least ${minWords})`, "Pages with few words count as 'thin content' and do not rank.", 2);
    add(sections.filter((s) => s.h).length >= 2, "Uses at least two sub-headings", "Headings that start with ## make the content easier to scan.");
  }
  if (primary) {
    add(has(title, primary), `Main keyword "${primary}" is in the title`, "With the main keyword in the title, Google understands the page topic right away.", 2);
    add(has(description, primary), "Main keyword is in the description", "The keyword shows in bold in the description, which gets more clicks.");
    if (h1) add(has(h1, primary), "Main keyword is in the H1", "Put the main keyword (or a natural form of it) in the H1.");
    if (sections.length) {
      add(has(firstPara, primary), "Main keyword appears in the first paragraph", "Having the keyword in the first paragraph makes the topic clear quickly.");
      const n = occurrences(body, primary);
      const density = total ? (n * words(primary).length * 100) / total : 0;
      add(n >= 2, `Main keyword used ${n} times in the text`, "The keyword should appear naturally in the text at least 2 times.");
      add(density <= 3, `Keyword density ${density.toFixed(1)}% (under 3%)`, "Using the keyword too many times (keyword stuffing) can get a Google penalty.", 2);
    }
  } else {
    add(false, "A main keyword is set", "Choose a main keyword for this page (the first keyword in the Keywords box).", 2);
  }
  if (secondary.length && sections.length) {
    const used = secondary.filter((k) => has(body, k) || has(title, k) || has(description, k));
    add(used.length >= Math.min(page.minSecondary ?? 3, secondary.length), `${used.length} of ${secondary.length} secondary keywords used`, "Secondary and long-tail keywords help the page show up in more searches.");
  }
  const max = checks.reduce((n, c) => n + c.weight, 0);
  const got = checks.reduce((n, c) => n + (c.ok ? c.weight : 0), 0);
  return { score: max ? Math.round((got * 100) / max) : 0, checks, words: total };
}
