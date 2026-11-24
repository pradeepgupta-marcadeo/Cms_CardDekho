// Rich-text bodies. The editor produces HTML; this module makes it safe, and converts between that HTML
// and the plain "sections" (heading + paragraphs) the SEO checker and the website's fallback use.
import sanitizeHtml from "sanitize-html";

const ALIGN = [/^(left|right|center|justify)$/];

/** Only the markup an article needs. Scripts, iframes, styles, event handlers and unknown links are dropped. */
export const cleanHtml = (html) =>
  sanitizeHtml(String(html ?? ""), {
    allowedTags: ["h2", "h3", "h4", "p", "br", "strong", "em", "u", "s", "blockquote", "ul", "ol", "li", "a", "hr", "table", "thead", "tbody", "tr", "th", "td", "figure", "figcaption", "img"],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "width", "height", "loading", "decoding"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan", "scope"],
      figure: ["class", "style"],
      p: ["style"],
      h2: ["style"],
      h3: ["style"],
      h4: ["style"],
      li: ["style"],
    },
    allowedClasses: { figure: ["table", "image", "image_resized", "image-style-side", "image-style-align-left", "image-style-align-right", "image-style-block-align-left", "image-style-block-align-right"] },
    allowedStyles: { "*": { "text-align": ALIGN }, figure: { width: [/^\d{1,3}(\.\d+)?%$/], "text-align": ALIGN } },
    allowedSchemes: ["https", "http", "mailto", "tel"],
    allowedSchemesByTag: { img: ["https", "http"] },
    transformTags: {
      h1: "h2",
      b: "strong",
      i: "em",
      strike: "s",
      img: (tag, attribs) => ({ tagName: "img", attribs: { ...attribs, loading: "lazy", decoding: "async" } }),
      a: (tag, attribs) => ({ tagName: "a", attribs: { ...attribs, ...(attribs.target === "_blank" ? { rel: "noopener noreferrer" } : {}) } }),
    },
    // Empty paragraphs from the editor are noise.
    exclusiveFilter: (frame) => frame.tag === "p" && !frame.text.trim() && !frame.mediaChildren?.length,
  }).trim();

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s) => String(s ?? "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
const text = (html) => unesc(String(html ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Sections ({h, p[]}) as HTML, for an article that was written as plain sections (the AI scraper does this). */
export const sectionsToHtml = (sections) =>
  (sections ?? [])
    .map((s) => {
      const [first, ...rest] = (s.p ?? []).map((p) => `<p>${esc(p)}</p>`);
      const list = (tag, items) => (items?.length ? `<${tag}>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</${tag}>` : "");
      // The same markup the editor's table button writes, so it can be edited there.
      const table = s.table?.rows?.length
        ? `<figure class="table"><table><thead><tr>${s.table.head.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${s.table.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></figure>`
        : "";
      return [s.h ? `<h2>${esc(s.h)}</h2>` : "", first ?? "", list("ul", s.bullets), list("ol", s.steps), table, ...rest].join("");
    })
    .join("");

/** HTML as sections: every h2-h4 starts a section; paragraphs, list items and table cells become its paragraphs. */
export function htmlToSections(html) {
  const out = [];
  let cur = null;
  for (const m of String(html ?? "").matchAll(/<(h[2-4]|p|li|td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[1].toLowerCase();
    const t = text(m[2]);
    if (!t) continue;
    if (tag[0] === "h") {
      cur = { h: t, p: [] };
      out.push(cur);
    } else {
      if (!cur) {
        cur = { h: "", p: [] };
        out.push(cur);
      }
      cur.p.push(t);
    }
  }
  return out;
}

export const slugName = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
