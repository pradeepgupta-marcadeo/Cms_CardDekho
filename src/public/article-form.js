// Article editor: Content / SEO panes, the Draft-Published switch, and the live search preview.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

for (const btn of $$("[data-pane-btn]")) {
  btn.addEventListener("click", () => {
    for (const b of $$("[data-pane-btn]")) b.classList.toggle("on", b === btn);
    for (const p of $$("[data-pane]")) p.hidden = p.dataset.pane !== btn.dataset.paneBtn;
  });
}

// The switch and the Status box are the same setting.
const sw = $("[data-publish-switch]");
const status = $("[data-status]");
const paint = () => {
  $("[data-sw-draft]").classList.toggle("muted", sw.checked);
  $("[data-sw-pub]").classList.toggle("muted", !sw.checked);
};
sw?.addEventListener("change", () => {
  status.value = sw.checked ? "published" : "draft";
  paint();
});
status?.addEventListener("change", () => {
  sw.checked = status.value === "published";
  paint();
});
if (sw) paint();

// A pane that holds a failed required field must be visible, or the browser cannot point at it.
$("[data-article-form]")?.addEventListener(
  "invalid",
  (e) => {
    const pane = e.target.closest("[data-pane]");
    if (pane?.hidden) $(`[data-pane-btn="${pane.dataset.pane}"]`)?.click();
  },
  true,
);

// Search preview follows the fields.
const bind = (field, target, fallback) => {
  const el = $(field);
  const out = $(target);
  if (!el || !out) return;
  const update = () => (out.textContent = el.value.trim() || fallback());
  el.addEventListener("input", update);
};
bind("#seo_title", "[data-prev-title]", () => $("#title")?.value || "Article title");
$("#title")?.addEventListener("input", () => {
  if (!$("#seo_title")?.value.trim()) $("[data-prev-title]").textContent = $("#title").value || "Article title";
});
bind("#seo_description", "[data-prev-desc]", () => $("#excerpt")?.value || "Add a meta description to control this line.");
bind("#slug", "[data-prev-slug]", () => "article-slug");

// ---- Image cards: Listing image, Detail banner, Social image ----
const csrfToken = document.querySelector('meta[name="csrf"]')?.content ?? "";
for (const card of $$("[data-imgcard]")) {
  const file = $("[data-file]", card);
  const url = $("[data-url]", card);
  const w = $("[data-w]", card);
  const h = $("[data-h]", card);
  const err = $("[data-error]", card);
  const drop = $("[data-drop]", card);
  const show = (src) => {
    $("[data-preview]", card).src = src || "";
    $("[data-empty]", card).hidden = Boolean(src);
    $("[data-filled]", card).hidden = !src;
  };
  const set = (src, width, height) => {
    url.value = src ?? "";
    w.value = width ?? "";
    h.value = height ?? "";
    show(src);
  };
  const fail = (msg) => {
    err.textContent = msg;
    err.hidden = !msg;
  };
  async function upload(f) {
    if (!f) return;
    fail("");
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) return fail("Choose a JPG, PNG or WebP image.");
    if (f.size > 6 * 1024 * 1024) return fail("That file is over 6 MB.");
    const body = new FormData();
    body.append("file", f);
    try {
      const res = await fetch("/admin/media/upload", { method: "POST", body, headers: { "x-csrf-token": csrfToken, accept: "application/json" } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Upload failed (${res.status})`);
      set(json.url, json.w, json.h);
    } catch (e) {
      fail(e.message);
    } finally {
      file.value = "";
    }
  }
  for (const b of $$("[data-choose]", card)) b.addEventListener("click", () => file.click());
  file.addEventListener("change", () => upload(file.files?.[0]));
  $("[data-remove]", card)?.addEventListener("click", () => set("", "", ""));
  // A pasted link is checked and saved on our server when the article is saved.
  url.addEventListener("input", () => {
    w.value = "";
    h.value = "";
    show(url.value.trim());
  });
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    upload(e.dataTransfer.files?.[0]);
  });
}

// ---- Tags: type and press Enter ----
const tagBox = $("[data-tags]");
if (tagBox) {
  const value = $("[data-tags-value]", tagBox);
  const chips = $("[data-chips]", tagBox);
  const input = $("[data-tag-input]", tagBox);
  let list = value.value.split(",").map((t) => t.trim()).filter(Boolean);
  const draw = () => {
    chips.replaceChildren(
      ...list.map((t) => {
        const chip = document.createElement("span");
        chip.className = "chip-tag";
        chip.textContent = t;
        const x = document.createElement("button");
        x.type = "button";
        x.textContent = "×";
        x.setAttribute("aria-label", `Remove tag ${t}`);
        x.addEventListener("click", () => {
          list = list.filter((v) => v !== t);
          draw();
        });
        chip.append(x);
        return chip;
      }),
    );
    value.value = list.join(",");
  };
  const add = (raw) => {
    const t = raw.replace(/[,\n]/g, " ").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 40);
    if (t && !list.includes(t) && list.length < 20) list.push(t);
    input.value = "";
    draw();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(input.value);
    } else if (e.key === "Backspace" && !input.value && list.length) {
      list.pop();
      draw();
    }
  });
  input.addEventListener("blur", () => input.value && add(input.value));
  draw();
}

// ---- Category: "+ New" adds an option ----
$("[data-new-category]")?.addEventListener("click", () => {
  const name = window.prompt("Name of the new category (for example: launch, safety, pricing)");
  const clean = String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40);
  if (!clean) return;
  const select = $("[data-category]");
  let opt = [...select.options].find((o) => o.value === clean);
  if (!opt) {
    opt = new Option(clean, clean);
    select.add(opt);
  }
  select.value = clean;
});
