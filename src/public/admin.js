// Small enhancements for the CMS screens. Everything works without it; this
// adds confirmations, live SEO scoring, counters and upload helpers.
import { checkSeo } from "/static/lib/seo-check.js";
import { sectionsFromText } from "/static/lib/text.js";

const csrf = document.querySelector('meta[name="csrf"]')?.content ?? "";
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Ask before destructive actions.
document.addEventListener("submit", (e) => {
  const form = e.target;
  const btn = e.submitter;
  const msg = btn?.dataset.confirm ?? form.dataset.confirm;
  if (msg && !window.confirm(msg)) {
    e.preventDefault();
    return;
  }
  const busy = btn?.dataset.busy ?? form.dataset.busy;
  if (busy) {
    for (const b of $$("button", form)) b.disabled = true;
    if (btn) btn.textContent = busy;
    // Disabled buttons are not submitted, so keep the clicked button's value.
    if (btn?.name) {
      const hidden = Object.assign(document.createElement("input"), { type: "hidden", name: btn.name, value: btn.value });
      form.append(hidden);
    }
  }
});

// Character counters next to SEO fields.
for (const el of $$("[data-count]")) {
  const out = document.createElement("div");
  out.className = "hint";
  el.after(out);
  const limits = el.tagName === "TEXTAREA" ? [120, 160] : [30, 60];
  const update = () => {
    const n = el.value.trim().length;
    out.textContent = `${n} characters ${n === 0 ? "(empty: the page's own text is used)" : n < limits[0] ? "(too short)" : n > limits[1] ? "(too long)" : "(good)"}`;
    out.style.color = n === 0 ? "" : n < limits[0] || n > limits[1] ? "#b45309" : "#15803d";
  };
  el.addEventListener("input", update);
  update();
}

// Live SEO score on the article editor.
const seoForm = document.querySelector("[data-seo-form]");
// Sections (heading + paragraphs) from the editor's HTML, the same way the server reads it.
const sectionsFromHtml = (html) => {
  const doc = new DOMParser().parseFromString(String(html ?? ""), "text/html");
  const out = [];
  let cur = null;
  for (const el of doc.body.querySelectorAll("h2, h3, h4, p, li, td, th")) {
    const t = el.textContent.replace(/s+/g, " ").trim();
    if (!t) continue;
    if (/^H[2-4]$/.test(el.tagName)) {
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
};

if (seoForm && (seoForm.querySelector('[data-seo="body"]') || seoForm.querySelector('[data-seo="html"]'))) {
  const get = (k) => seoForm.querySelector(`[data-seo="${k}"]`)?.value ?? "";
  const scoreEl = document.querySelector("[data-seo-score]");
  const listEl = document.querySelector("[data-seo-checks]");
  const wordsEl = document.querySelector("[data-seo-words]");
  const kind = seoForm.querySelector('[name="kind"]');
  let timer;
  const run = () => {
    const kws = get("keywords").split(/\n/).map((s) => s.trim()).filter(Boolean);
    const h1 = get("h1");
    const r = checkSeo({
      title: get("title") || h1,
      description: get("description") || seoForm.querySelector('[name="excerpt"]')?.value || "",
      h1,
      sections: seoForm.querySelector('[data-seo="html"]') ? sectionsFromHtml(get("html")) : sectionsFromText(get("body")),
      primary: kws[0],
      secondary: kws.slice(1),
      minWords: kind?.value === "news" ? 300 : 500,
    });
    scoreEl.textContent = `${r.score}%`;
    scoreEl.style.color = r.score >= 80 ? "#15803d" : r.score >= 60 ? "#b45309" : "#b91c1c";
    if (wordsEl) wordsEl.textContent = `${r.words} words`;
    listEl.replaceChildren(
      ...r.checks.map((c) => {
        const li = document.createElement("li");
        li.className = c.ok ? "ok" : "";
        li.textContent = c.label;
        if (!c.ok) {
          const h = document.createElement("div");
          h.className = "hint";
          h.textContent = c.hint;
          li.append(h);
        }
        return li;
      }),
    );
  };
  seoForm.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  run();
}

// JSON boxes: show a clear message when the JSON is broken.
for (const el of $$("textarea[data-json]")) {
  const out = document.createElement("div");
  out.className = "hint";
  el.after(out);
  const check = () => {
    try {
      if (el.value.trim()) JSON.parse(el.value);
      out.textContent = "";
    } catch (err) {
      out.textContent = `JSON error: ${err.message}. Save will be refused until this is fixed.`;
      out.style.color = "#b91c1c";
    }
  };
  el.addEventListener("blur", check);
}

// Keyword chips: click + to add the phrase to the keywords box.
for (const b of $$("[data-add-kw]")) {
  b.addEventListener("click", () => {
    const box = document.querySelector('[name="keywords"]');
    if (!box) return;
    const list = box.value.split(/\n/).map((s) => s.trim()).filter(Boolean);
    if (!list.includes(b.dataset.addKw)) list.push(b.dataset.addKw);
    box.value = list.join("\n");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// Image fields: upload a file and drop its address into the field.
for (const b of $$("[data-pick-media]")) {
  b.addEventListener("click", () => {
    const target = document.getElementById(b.dataset.pickMedia);
    const input = Object.assign(document.createElement("input"), { type: "file", accept: "image/png,image/jpeg,image/webp,image/svg+xml" });
    input.addEventListener("change", async () => {
      if (!input.files?.[0]) return;
      const data = new FormData();
      data.append("file", input.files[0]);
      b.textContent = "Uploading…";
      b.disabled = true;
      try {
        const res = await fetch("/admin/media/upload", { method: "POST", body: data, headers: { "x-csrf-token": csrf, accept: "application/json" } });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Upload failed");
        target.value = JSON.stringify({ src: json.url, w: json.w, h: json.h });
        b.textContent = "Uploaded. Click Save.";
      } catch (err) {
        b.textContent = `Failed: ${err.message}`;
      } finally {
        b.disabled = false;
      }
    });
    input.click();
  });
}

// Import progress: poll the run until it finishes, then reload to show the result.
const runLog = document.querySelector("[data-run-log]");
if (runLog) {
  const id = runLog.dataset.runLog;
  const statusEl = document.querySelector("[data-run-status]");
  const poll = async () => {
    const res = await fetch(`/admin/imports/runs/${id}?format=json`, { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const run = await res.json();
    runLog.textContent = run.log || "Working…";
    runLog.scrollTop = runLog.scrollHeight;
    if (run.status === "running") setTimeout(poll, 2000);
    else if (statusEl?.textContent.trim() === "running") window.location.reload();
  };
  if (statusEl?.textContent.trim() === "running") setTimeout(poll, 1500);
}

for (const el of $$("[data-copy]")) el.addEventListener("focus", () => el.select());

// "Select all" checkbox in review lists.
for (const box of $$("[data-check-all]")) {
  box.addEventListener("change", () => {
    for (const c of $$('input[type="checkbox"][name="ids"]', box.closest("form"))) c.checked = box.checked;
  });
}

// CarScrapper: follow the live log, progress and NEW / UPDATED / SAME counts, then reload for the final result.
const csLog = document.querySelector("[data-cs-log]");
if (csLog) {
  const id = csLog.dataset.csLog;
  const statusEl = document.querySelector("[data-cs-status]");
  const bar = document.querySelector("[data-cs-progress]");
  const barText = document.querySelector("[data-cs-progress-text]");
  const changes = document.querySelector("[data-cs-changes]");
  const poll = async () => {
    try {
      const res = await fetch(`/admin/carscraper/runs/${id}?format=json`, { headers: { accept: "application/json" } });
      if (!res.ok) return setTimeout(poll, 5000);
      const run = await res.json();
      const s = run.summary || {};
      const follow = csLog.scrollTop + csLog.clientHeight >= csLog.scrollHeight - 30;
      csLog.textContent = run.log || "Starting…";
      if (follow) csLog.scrollTop = csLog.scrollHeight;
      if (bar) {
        bar.max = s.total || 1;
        bar.value = s.done || 0;
      }
      if (barText) barText.textContent = `Step ${s.step}/${s.steps} · ${s.done} / ${s.total}`;
      for (const el of $$("[data-cs-count]")) el.textContent = (s.counts || {})[el.dataset.csCount] ?? 0;
      if (changes && s.changes?.length) changes.textContent = [...s.changes].reverse().join("\n");
      const extra = document.querySelector("[data-cs-extra]");
      if (extra) {
        const parts = [];
        if (s.db) parts.push(`CMS database: ${s.db.NEW} new · ${s.db.UPDATED} updated · ${s.db.SAME} unchanged`);
        if (s.photos) parts.push(`Photos (HD): ${s.photos.done} new · ${s.photos.upgraded ?? 0} replaced by HD · ${s.photos.failed} failed · ${s.photos.skipped} already there`);
        if (s.site) parts.push(`Website: ${s.site.NEW} added · ${s.site.UPDATED} updated · ${s.site.SAME} unchanged`);
        if (parts.length) extra.textContent = parts.join("  |  ");
      }
      if (run.status === "running") setTimeout(poll, 2000);
      else window.location.reload();
    } catch {
      setTimeout(poll, 5000);
    }
  };
  csLog.scrollTop = csLog.scrollHeight;
  if (statusEl?.textContent.trim() === "running") setTimeout(poll, 1500);
}

// CarScrapper schedule form: show only the fields the chosen frequency needs.
const csFreq = document.querySelector("[data-cs-freq]");
if (csFreq) {
  const sync = () => {
    for (const el of $$("[data-cs-when]")) el.hidden = !el.dataset.csWhen.split(" ").includes(csFreq.value);
  };
  csFreq.addEventListener("change", sync);
  sync();
}

// Scraper job page: follow the log while the job runs, then reload for the final result.
const scrapeLog = document.querySelector("[data-scrape-log]");
if (scrapeLog) {
  const id = scrapeLog.dataset.scrapeLog;
  const statusEl = document.querySelector("[data-scrape-status]");
  const line = (l) => `${new Date(l.createdAt).toLocaleTimeString("en-IN", { hour12: false })}  ${l.level.toUpperCase().padEnd(5)} ${l.message}`;
  const poll = async () => {
    const res = await fetch(`/admin/scraper/jobs/${id}?format=json`, { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const job = await res.json();
    scrapeLog.textContent = job.logs.map(line).join("\n") || "Working…";
    scrapeLog.scrollTop = scrapeLog.scrollHeight;
    if (["running", "queued"].includes(job.status)) setTimeout(poll, 2500);
    else window.location.reload();
  };
  if (["running", "queued"].includes(statusEl?.textContent.trim())) setTimeout(poll, 2000);
}
