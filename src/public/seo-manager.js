// The SEO tab: edit a page's snippet in a dialog, auto-fix one page or every card on the screen.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const csrf = document.querySelector('meta[name="csrf"]')?.content ?? "";

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf, accept: "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

const modal = $("[data-seo-modal]");
let current = null; // the card being edited

const count = (el, out, lo, hi) => {
  const n = el.value.trim().length;
  out.textContent = `${n} characters ${n >= lo && n <= hi ? "(good)" : `(aim for ${lo}–${hi})`}`;
  out.style.color = n >= lo && n <= hi ? "#166534" : "#92400e";
};
const refresh = () => {
  count($("[data-m-title]"), $("[data-m-title-count]"), 30, 60);
  count($("[data-m-desc]"), $("[data-m-desc-count]"), 120, 160);
  $("[data-m-prev-title]").textContent = $("[data-m-title]").value || "Title";
  $("[data-m-prev-desc]").textContent = $("[data-m-desc]").value || "Description";
};
for (const el of [$("[data-m-title]"), $("[data-m-desc]")]) el?.addEventListener("input", refresh);

const fill = (card) => {
  $("[data-m-title]").value = card.title ?? "";
  $("[data-m-desc]").value = card.description ?? "";
  $("[data-m-kw]").value = (card.keywords ?? []).join("\n");
  $("[data-m-noindex]").checked = Boolean(card.noindex);
  refresh();
};

// Redraws a card from the server's answer.
function paint(el, card) {
  el.dataset.card = JSON.stringify(card);
  el.className = `seo-card ${card.score >= 100 ? "good" : card.score >= 60 ? "mid" : "low"}`;
  $("[data-score]", el).textContent = `${card.score}%`;
  $(".seo-bar i", el).style.width = `${card.score}%`;
  const names = { title: "Title", description: "Description", keywords: "Keywords", image: "Image" };
  $(".seo-checks", el).replaceChildren(
    ...Object.entries(card.checks).map(([k, ok]) => Object.assign(document.createElement("li"), { className: ok ? "ok" : "", textContent: names[k] })),
  );
  $(".seo-title", el).textContent = card.title || "No title found";
  $(".seo-kws", el).replaceChildren(
    ...card.keywords.slice(0, 3).map((k) => Object.assign(document.createElement("span"), { className: "seo-kw", textContent: k })),
  );
}
const cardOf = (el) => JSON.parse(el.dataset.card);

for (const el of $$(".seo-card")) {
  $("[data-edit]", el).addEventListener("click", () => {
    current = el;
    const c = cardOf(el);
    $("[data-m-name]").textContent = c.name;
    $("[data-m-path]").textContent = c.path;
    $("[data-m-adv]").href = `/admin/seo/edit?path=${encodeURIComponent(c.path)}`;
    $("[data-m-err]").hidden = true;
    fill(c);
    modal.showModal();
  });
  $("[data-fix]", el).addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = "Fixing…";
    try {
      await post("/admin/seo/autofix", { paths: [cardOf(el).path] });
      await refreshCard(el);
    } catch (err) {
      alert(err.message);
    } finally {
      b.disabled = false;
      b.textContent = "✨ Auto-fix";
    }
  });
}

// Reads the card again (the server re-reads the live page).
async function refreshCard(el) {
  await new Promise((r) => setTimeout(r, 3000)); // the website refreshes a few seconds after a change
  const { card } = await post("/admin/seo/card", { path: cardOf(el).path });
  paint(el, card);
}

$("[data-m-close]")?.addEventListener("click", () => modal.close());

$("[data-m-suggest]")?.addEventListener("click", async () => {
  const err = $("[data-m-err]");
  err.hidden = true;
  try {
    const s = await post("/admin/seo/suggest", { path: cardOf(current).path });
    fill({ ...cardOf(current), ...s, noindex: $("[data-m-noindex]").checked });
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
});

$("[data-m-save]")?.addEventListener("click", async (e) => {
  const b = e.currentTarget;
  const err = $("[data-m-err]");
  err.hidden = true;
  b.disabled = true;
  try {
    const { card } = await post("/admin/seo/quick", {
      path: cardOf(current).path,
      title: $("[data-m-title]").value,
      description: $("[data-m-desc]").value,
      keywords: $("[data-m-kw]").value.split(/\r?\n/),
      noindex: $("[data-m-noindex]").checked,
    });
    paint(current, card);
    modal.close();
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    b.disabled = false;
  }
});

$("[data-autofix-all]")?.addEventListener("click", async (e) => {
  const b = e.currentTarget;
  const cards = $$(".seo-card");
  b.disabled = true;
  b.textContent = "Fixing…";
  try {
    const r = await post("/admin/seo/autofix", { paths: cards.map((c) => cardOf(c).path) });
    b.textContent = r.fixed ? `Fixed ${r.fixed} page(s) · reloading…` : "Nothing to fix";
    if (r.fixed) setTimeout(() => location.reload(), 900);
    else setTimeout(() => ((b.disabled = false), (b.textContent = "✨ Auto-fix all shown")), 1800);
  } catch (err) {
    alert(err.message);
    b.disabled = false;
    b.textContent = "✨ Auto-fix all shown";
  }
});
