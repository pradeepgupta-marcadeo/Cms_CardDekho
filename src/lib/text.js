export const slugify = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

export const words = (s) => String(s ?? "").split(/\s+/).filter(Boolean);

/**
 * A section may also carry `bullets`, `steps` (a numbered list) and a `table` ({head, rows}). The SEO checks, the word
 * count and the website's plain fallback only know headings and paragraphs, so this turns the extras into paragraphs.
 */
export const flattenSections = (sections) =>
  (sections ?? []).map((s) => ({
    h: s.h ?? "",
    p: [...(s.p ?? []), ...(s.bullets ?? []), ...(s.steps ?? []), ...(s.table ? s.table.rows.map((r) => r.join(": ")) : [])].filter(Boolean),
  }));

export const countWords = (sections) =>
  sections.reduce((n, s) => n + words(s.h).length + (s.p ?? []).reduce((m, p) => m + words(p).length, 0), 0);

// "a, b ,c" or ["a","b"] -> ["a","b","c"]
export const toList = (v) =>
  (Array.isArray(v) ? v : String(v ?? "").split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);

// Body sections are edited as plain text: "## Heading" starts a section, blank lines split paragraphs.
export function sectionsFromText(text) {
  const out = [];
  let cur = null;
  for (const block of String(text ?? "").replace(/\r/g, "").split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t) continue;
    const m = t.match(/^##\s+(.+?)(?:\n([\s\S]*))?$/);
    if (m) {
      cur = { h: m[1].trim(), p: [] };
      out.push(cur);
      if (m[2]?.trim()) cur.p.push(m[2].trim().replace(/\n/g, " "));
    } else {
      if (!cur) {
        cur = { h: "", p: [] };
        out.push(cur);
      }
      cur.p.push(t.replace(/\n/g, " "));
    }
  }
  return out;
}

export const sectionsToText = (sections) =>
  (sections ?? []).map((s) => [s.h ? `## ${s.h}` : "", ...(s.p ?? [])].filter(Boolean).join("\n\n")).join("\n\n");

export const clamp = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…");

export const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

export const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
