// News Manager behaviour: row selection, the "Run scraper" window with its live log, and Delete by date.
const csrf = document.querySelector('meta[name="csrf"]')?.content ?? "";
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---- Selecting rows ----
const bulk = $("#bulk");
const rows = $$("[data-row]");
const all = $("[data-all]");
function syncSelection() {
  const n = rows.filter((r) => r.checked).length;
  if (bulk) {
    bulk.hidden = n === 0;
    $("[data-selected]", bulk).textContent = `${n} selected`;
  }
  if (all) all.checked = rows.length > 0 && n === rows.length;
}
all?.addEventListener("change", () => {
  for (const r of rows) r.checked = all.checked;
  syncSelection();
});
for (const r of rows) r.addEventListener("change", syncSelection);

// ---- Opening and closing the two windows ----
for (const btn of $$("[data-open]")) btn.addEventListener("click", () => document.getElementById(btn.dataset.open)?.showModal());
for (const dlg of $$("dialog.modal")) {
  $("[data-close]", dlg)?.addEventListener("click", () => dlg.close());
  dlg.addEventListener("cancel", (e) => {
    if (dlg.dataset.running === "1") e.preventDefault(); // Stop the run first.
  });
}

// ---- Run scraper / collector: every window that has a Run button streams its own endpoint ----
for (const scraper of $$("dialog.modal").filter((d) => $("[data-run]", d))) {
  const logEl = $("[data-log]", scraper);
  const runBtn = $("[data-run]", scraper);
  const stopBtn = $("[data-stop]", scraper);
  const done = $("[data-done]", scraper);
  const closeBtn = $("[data-close]", scraper);
  let controller = null;
  let wrote = false;

  const tone = (line) => {
    if (/^(Saved|Done|Using)/i.test(line)) return "good";
    if (/^ERROR/i.test(line)) return "bad";
    if (/^(Processing|Fetching)/i.test(line)) return "info";
    if (/^(Scraped|Cleaned|Writing)/i.test(line)) return "warn";
    if (/^(Stopped|Dropped)/i.test(line)) return "violet";
    return "";
  };
  const add = (line) => {
    $("[data-empty]", logEl)?.remove();
    const div = document.createElement("div");
    div.className = tone(line);
    div.textContent = line;
    logEl.append(div);
    if (/^Saved/.test(line)) wrote = true;
    logEl.scrollTop = logEl.scrollHeight;
  };
  const running = (on) => {
    scraper.dataset.running = on ? "1" : "0";
    runBtn.hidden = on;
    stopBtn.hidden = !on;
    closeBtn.disabled = on;
    for (const f of $$("[data-f]", scraper)) f.disabled = on;
  };

  runBtn.addEventListener("click", async () => {
    logEl.replaceChildren();
    done.hidden = true;
    wrote = false;
    running(true);
    controller = new AbortController();
    const body = new URLSearchParams(Object.fromEntries($$("[data-f]", scraper).map((f) => [f.dataset.f, f.value])));
    try {
      const res = await fetch(scraper.dataset.endpoint || "/admin/articles/scrape", { method: "POST", body, signal: controller.signal, headers: { "x-csrf-token": csrf, "content-type": "application/x-www-form-urlencoded" } });
      if (!res.ok || !res.body) {
        add(`ERROR  ${(await res.text().catch(() => "")).slice(0, 200) || res.status}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let carry = "";
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        carry += decoder.decode(value, { stream: true });
        const parts = carry.split("\n");
        carry = parts.pop() ?? "";
        for (const line of parts) if (line.trim()) add(line);
      }
      if (carry.trim()) add(carry.trim());
      done.hidden = false;
    } catch (err) {
      if (err.name !== "AbortError") add(`ERROR  ${err.message}`);
    } finally {
      running(false);
    }
  });
  stopBtn.addEventListener("click", () => {
    controller?.abort();
    add("Stopped by user");
    running(false);
  });
  scraper.addEventListener("close", () => {
    controller?.abort();
    if (wrote) location.reload(); // the new drafts are in the table behind the window
  });
}

// ---- Delete by date ----
const dd = $("#delete-date");
if (dd) {
  const val = (n) => $(`[data-f="${n}"]`, dd).value;
  const msg = $("[data-msg]", dd);
  const confirmBtn = $("[data-confirm-delete]", dd);
  const post = async (extra) => {
    const body = new URLSearchParams({ dateField: val("dateField"), from: val("from"), to: val("to"), scope: val("scope"), ...extra });
    const res = await fetch("/admin/articles/delete-by-date", { method: "POST", body, headers: { "x-csrf-token": csrf, "content-type": "application/x-www-form-urlencoded", accept: "application/json" } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  };
  for (const f of $$("[data-f]", dd)) f.addEventListener("input", () => (confirmBtn.disabled = true));
  $("[data-check]", dd).addEventListener("click", async () => {
    try {
      const { count, published } = await post({});
      msg.textContent = count ? `${count} article${count === 1 ? "" : "s"} match${published ? ` (${published} published, their web addresses will redirect to the news page)` : ""}. Press Delete to remove them.` : "Nothing matches those dates.";
      confirmBtn.disabled = count === 0;
    } catch (err) {
      msg.textContent = err.message;
      confirmBtn.disabled = true;
    }
  });
  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    try {
      const { deleted } = await post({ confirm: "1" });
      msg.textContent = `${deleted} deleted.`;
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}
