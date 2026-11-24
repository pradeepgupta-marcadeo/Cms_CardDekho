// What we ask the AI to write, and the checks its output must pass before an
// editor sees it. Every draft is saved unpublished: a person reviews it first.
import { generateJson } from "./ai.js";
import { checkSeo } from "./seo-check.js";
import { clamp, countWords, flattenSections, slugify } from "./text.js";

const RULES = `You write for Wheelora, an Indian car research website. Rules:
- Use ONLY the facts given in the brief. Never invent prices, dates, specifications, quotes or sales numbers. If a fact is missing, write around it or say it is not yet confirmed.
- Write original sentences. Do not copy phrases from any source text; restate facts in your own words and add useful context for an Indian car buyer.
- Indian English, prices in rupees as "Rs 9.99 lakh". Short paragraphs of 2 to 4 sentences, plain and friendly, no hype words like "game-changer" or "revolutionary".
- Keywords are given in lowercase only so they can be matched; always write them with normal capitalisation ("Honda Elevate price", never "honda elevate price"), and bend them into natural grammar where needed.
- SEO: put the main keyword in the title, in the meta description, in the first paragraph and naturally once or twice more in the text, not more. Work in the secondary keywords where they read naturally, and use close variants of the main keyword for the other mentions; never stuff them.
- seoTitle: 45 to 60 characters. seoDescription: 130 to 155 characters, a complete sentence that makes people want to click. The page heading (title) must not be identical to seoTitle.
- sections: 4 to 7 sections, each with a clear sub-heading "h" (no numbering, no markdown) and 1 to 4 paragraphs in "p".
- Make it easy to scan, like a good magazine story. Besides paragraphs, use: "bullets" (3 to 6 short points, each under 25 words) in at least two sections; "steps" (a numbered list of 3 to 6 short steps) in a section where order matters, such as how to book, what to check or what happens next; and a "table" in one section that compares or lists facts, for example variants and prices, specifications, rivals or dates: {"head": [column names], "rows": [[cells]]} with 2 to 5 columns and 3 to 8 rows, every cell a short plain string taken from the facts. Only add a list or table when the facts support it; never pad. Each such section still keeps one short introductory paragraph in "p". Do not repeat the same facts in both a list and a paragraph.
- faqs: 3 to 5 questions real buyers type into Google, each answered in 1 to 3 sentences using the facts given.
- No markdown, HTML or emoji inside any string.`;

export const SEO_TARGET = 95;
const MAX_REWRITES = 3;

const SHAPE = `Return JSON: {"title": string, "seoTitle": string, "seoDescription": string, "excerpt": string (1-2 sentences, under 200 characters), "slug": string (lowercase-hyphenated, 3-8 words, include the main keyword), "category": string, "sections": [{"h": string, "p": [string], "bullets": [string] (optional), "steps": [string] (optional), "table": {"head": [string], "rows": [[string]]} (optional)}], "faqs": [{"q": string, "a": string}], "keywordsUsed": [string]}`;

const list = (v) => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : []);
/** One section as the model wrote it, reduced to the shapes the editor and website can show. */
function cleanSection(s) {
  const out = { h: String(s.h ?? "").trim(), p: list(s.p) };
  const bullets = list(s.bullets).slice(0, 8);
  const steps = list(s.steps).slice(0, 8);
  if (bullets.length >= 2) out.bullets = bullets;
  if (steps.length >= 2) out.steps = steps;
  const head = list(s.table?.head).slice(0, 5);
  const cols = head.length;
  const rows = (Array.isArray(s.table?.rows) ? s.table.rows : []).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "").trim()) : [])).filter((r) => r.length === cols && r.some(Boolean)).slice(0, 10);
  if (cols >= 2 && rows.length >= 2) out.table = { head, rows };
  return out;
}

function brief({ kind, facts, primary, secondary, minWords, minSecondary = 3, extra = "" }) {
  return [
    `Write a ${kind}. Aim for at least ${minWords} words in "sections".`,
    `Main keyword: ${primary || "(choose the most natural search phrase for this topic)"}`,
    secondary?.length ? `Secondary keywords: ${secondary.join("; ")}
Use at least ${Math.min(minSecondary, secondary.length)} of these secondary keywords, each word for word and in natural sentences. Spread the keywords over the whole page: some in sub-headings, some in FAQ questions, some in the body. Add the exact main keyword to the title and to one sub-heading. Never repeat any phrase so often that it reads as stuffing (main keyword under 2.5% of the words).` : "",
    primary ? `The main keyword "${primary}" has ${primary.split(/\s+/).length} words. In the body text (not counting the title or meta description) it must appear 2 or ${Math.max(2, Math.min(4, Math.floor((0.028 * Math.max(minWords, 480)) / primary.split(/\s+/).length)))} times in total, never more. Use secondary keywords and variants for everything else.` : "",
    extra,
    "FACTS:",
    facts,
    SHAPE,
  ].filter(Boolean).join("\n\n");
}

function tidy(draft, primary, secondary, minWords, minSecondary = 3) {
  const sections = (draft.sections ?? []).map(cleanSection).filter((s) => s.p.length || s.bullets || s.steps || s.table);
  const faqs = (draft.faqs ?? []).map((f) => ({ q: String(f.q ?? "").trim(), a: String(f.a ?? "").trim() })).filter((f) => f.q && f.a);
  const out = {
    title: String(draft.title ?? "").trim(),
    seoTitle: clamp(String(draft.seoTitle ?? draft.title ?? "").trim(), 60),
    seoDescription: clamp(String(draft.seoDescription ?? "").trim(), 160),
    excerpt: clamp(String(draft.excerpt ?? "").trim(), 220),
    slug: slugify(draft.slug || draft.title).split("-").slice(0, 10).join("-"),
    category: String(draft.category ?? "").trim().toLowerCase(),
    sections,
    faqs,
    keywords: [primary, ...(secondary ?? [])].filter(Boolean),
  };
  if (out.seoTitle.toLowerCase() === out.title.toLowerCase() || out.seoTitle.length < 30) {
    const alt = `${out.title} | Wheelora`;
    out.seoTitle = alt.length <= 60 ? alt : clamp(`${out.title.slice(0, 48).replace(/\s+\S*$/, "")} | Wheelora`, 60);
  }
  out.seo = checkSeo({ title: out.seoTitle, description: out.seoDescription, h1: out.title, sections, primary, secondary, minWords, minSecondary });
  out.words = countWords(flattenSections(sections));
  return out;
}

/** Writes an article and, if it misses the length or SEO bar, asks once more with the problems listed. */
export async function writeArticle({ kind, facts, primary, secondary = [], minWords = 600, minSecondary = 3, extra = "" }) {
  const prompt = brief({ kind, facts, primary, secondary, minWords, minSecondary, extra });
  let res = await generateJson({ system: RULES, prompt, maxTokens: 8192 });
  let draft = tidy(res.data, primary, secondary, minWords, minSecondary);
  // Aim for a near-perfect SEO score: while it is below the target, tell the AI exactly which checks
  // failed (with the numbers) and keep the best draft. Up to three rewrites.
  for (let attempt = 0; attempt < MAX_REWRITES && draft.seo.score < SEO_TARGET; attempt++) {
    const failed = draft.seo.checks.filter((c) => !c.ok);
    const retry = await generateJson({
      system: RULES,
      prompt: `${prompt}\n\nYour previous draft scored ${draft.seo.score}% on our SEO checks. Rewrite it so EVERY check passes. These failed:\n- ${failed.map((c) => c.label).join("\n- ")}\nThe main keyword is exactly "${primary}": it must appear word for word in seoTitle, title, seoDescription, the first paragraph and at least one sub-heading. In the body text it may appear 2 or 3 times in total, never more (a long phrase repeated more often counts as keyword stuffing). seoTitle must not be identical to title. seoTitle must be 30 to 60 characters and seoDescription 120 to 160 characters, counted exactly. Keep every fact; do not add facts.\n\nPrevious draft:\n${JSON.stringify(res.data).slice(0, 12000)}`,
      maxTokens: 8192,
    }).catch(() => null);
    if (!retry) break;
    const better = tidy(retry.data, primary, secondary, minWords, minSecondary);
    if (better.seo.score >= draft.seo.score) {
      draft = better;
      res = retry;
    }
  }
  return { ...draft, provider: res.provider, model: res.model };
}

export async function writeSeoMeta({ path, h1, text, primary, secondary = [] }) {
  const { data, provider } = await generateJson({
    system: RULES,
    prompt: `Write the Google search snippet for the page ${path}.\nPage heading: ${h1}\nMain keyword: ${primary}\nSecondary keywords: ${secondary.join("; ")}\nPage summary:\n${text.slice(0, 3000)}\n\nReturn JSON: {"title": string (45-60 characters, includes the main keyword, different from the heading), "description": string (130-155 characters, includes the main keyword)}`,
    maxTokens: 1024,
  });
  return { title: clamp(String(data.title ?? "").trim(), 60), description: clamp(String(data.description ?? "").trim(), 160), provider };
}

export async function suggestKeywords({ topic, existing = [] }) {
  const { data } = await generateJson({
    system: "You are an SEO researcher for the Indian car market. You know how Indians search on Google, including Hinglish phrasing.",
    prompt: `Suggest 25 search phrases Indian car buyers type for: ${topic}.\nMix head terms, question-style long-tail phrases ("is ... good for", "which ... to buy"), city phrases and comparisons. Skip these existing ones: ${existing.slice(0, 80).join("; ")}\nReturn JSON: {"keywords": [{"phrase": string (lowercase), "intent": "informational"|"commercial"|"transactional"|"navigational", "priority": "high"|"medium"|"long-tail"}]}`,
    maxTokens: 2048,
  });
  return (data.keywords ?? []).filter((k) => k?.phrase).map((k) => ({ phrase: String(k.phrase).toLowerCase().trim(), intent: k.intent ?? "informational", priority: ["high", "medium", "long-tail"].includes(k.priority) ? k.priority : "long-tail" }));
}

/**
 * The copy of a car's main page: summary, verdict, angle, pros, cons, a short buying guide and FAQs.
 * research: notes from third-party reviews, used for facts and opinions only (never quoted, never named).
 * extra: added instructions (for example after a draft repeated its research too closely).
 */
export async function writeCarCopy({ facts, primary, secondary, research = "", extra = "" }) {
  const { data, provider } = await generateJson({
    system: RULES,
    prompt: [
      `Write the buying-guide copy for a car's main page on Wheelora.`,
      `Main keyword: ${primary}`,
      `Secondary keywords: ${secondary.join("; ")}
Use at least 6 of them, spread over the summary, the guide sub-headings, the guide text and the FAQ questions, but only where they read naturally: bend them into normal grammar ("the Creta's top model costs", not "Creta top model price include"). Every FAQ question must be a real, natural question a buyer would type. Never force a keyword into a sentence that does not need it.`,
      `FACTS:\n${facts}`,
      research
        ? `RESEARCH NOTES from published reviews of this car. Use them only to understand its real strengths, weaknesses and how it drives. Never copy their wording: no run of more than five words may match the notes. Never mention who wrote them or any other website.\n${research}`
        : "",
      `This is a desk review written from data and published reviews: never claim that we drove, tested or road-tested the car, and do not write "our review confirms".`,
      extra,
      `Return JSON: {"summary": string (70 to 100 words: who the car is for, its price band and its two biggest strengths; starts with the main keyword), "verdict": string (60 to 90 words: our honest buying verdict, who should buy it and who should look elsewhere), "angle": string (one short phrase after "the" that only fits this car, under 70 characters; write your own, do not reuse any example), "pros": [3 or 4 short strings, each a concrete strength], "cons": [2 or 3 short strings, each a concrete weak point], "sections": [{"h": string, "p": [string]}] (3-4 sections, 350-500 words total, covering who it suits, what you get for the money, running costs, what to check on a test drive), "faqs": [{"q": string, "a": string}] (4-6, questions people type into Google, answered using only the facts)}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    maxTokens: 4096,
  });
  const sections = (data.sections ?? []).map((s) => ({ h: String(s.h ?? ""), p: (s.p ?? []).map(String) })).filter((s) => s.p.length);
  return {
    summary: String(data.summary ?? "").trim(),
    verdict: String(data.verdict ?? "").trim(),
    angle: String(data.angle ?? "").replace(/^the\s+/i, "").trim(),
    pros: (data.pros ?? []).map(String).slice(0, 4),
    cons: (data.cons ?? []).map(String).slice(0, 3),
    sections,
    faqs: (data.faqs ?? []).filter((f) => f?.q && f?.a).map((f) => ({ q: String(f.q), a: String(f.a) })),
    provider,
  };
}
