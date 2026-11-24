import { Router } from "express";
import multer from "multer";
import { one, query, rows } from "../db.js";
import { audit, contentChanged } from "../lib/publish.js";
import { slugName } from "../lib/rich.js";
import { saveImage } from "./media.js";

export const authorsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)) });
const PER = 20;

async function uniqueSlug(name, exceptId = 0) {
  const base = slugName(name) || "author";
  let slug = base;
  for (let i = 2; await one("SELECT 1 FROM authors WHERE slug = $1 AND id <> $2", [slug, exceptId]); i++) slug = `${base}-${i}`;
  return slug;
}

authorsRouter.get("/", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const state = ["active", "inactive"].includes(req.query.state) ? req.query.state : "";
  const page = Math.max(1, Number(req.query.page) || 1);
  const where = [];
  const params = [];
  if (q) where.push(`(a.name ILIKE $${params.push(`%${q}%`)} OR a.designation ILIKE $${params.length} OR a.email ILIKE $${params.length})`);
  if (state) where.push(state === "active" ? "a.active" : "NOT a.active");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (await one(`SELECT count(*)::int AS n FROM authors a ${clause}`, params)).n;
  const list = await rows(
    `SELECT a.*, (SELECT count(*)::int FROM articles x WHERE x.author_id = a.id) AS stories FROM authors a ${clause} ORDER BY a.active DESC, a.id DESC LIMIT ${PER} OFFSET ${(page - 1) * PER}`,
    params,
  );
  res.render("authors", { title: "Authors", list, q, state, page, pages: Math.max(1, Math.ceil(total / PER)), total, per: PER });
});

authorsRouter.get("/new", (req, res) => res.render("author-edit", { title: "New author", a: { id: null, name: "", designation: "", email: "", bio: "", image: "", active: true }, isNew: true }));

authorsRouter.get("/:id", async (req, res, next) => {
  const a = await one("SELECT * FROM authors WHERE id = $1", [req.params.id]);
  if (!a) return next();
  res.render("author-edit", { title: a.name, a, isNew: false });
});

async function save(req, res, id) {
  const b = req.body;
  const name = String(b.name ?? "").trim();
  const back = id ? `/admin/authors/${id}` : "/admin/authors/new";
  if (!name) {
    req.session.flash = { type: "err", text: "Name is required." };
    return res.redirect(back);
  }
  const email = String(b.email ?? "").trim();
  if (email && !/^\S+@\S+\.\S+$/.test(email)) {
    req.session.flash = { type: "err", text: "That email address does not look right." };
    return res.redirect(back);
  }
  try {
    let image = id ? (await one("SELECT image FROM authors WHERE id = $1", [id]))?.image : null;
    if (req.file) image = (await saveImage(req.file, { alt: name })).url;
    if (b.remove_image === "on") image = null;
    const fields = [name, await uniqueSlug(name, id ?? 0), String(b.designation ?? "").trim(), email, String(b.bio ?? "").trim(), image, b.active === "on"];
    let row;
    if (id) {
      row = await one("UPDATE authors SET name=$2, slug=$3, designation=$4, email=$5, bio=$6, image=$7, active=$8 WHERE id=$1 RETURNING id", [id, ...fields]);
      // Stories keep the name they were published under in step with the author.
      await query("UPDATE articles SET author = $2 WHERE author_id = $1", [id, name]);
    } else row = await one("INSERT INTO authors (name, slug, designation, email, bio, image, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", fields);
    await audit(req, id ? "update" : "create", "authors", row.id, name);
    await contentChanged();
    req.session.flash = { type: "ok", text: id ? "Author saved." : `${name} added. New stories are shared out among the active authors.` };
    res.redirect("/admin/authors");
  } catch (err) {
    req.session.flash = { type: "err", text: err.message };
    res.redirect(back);
  }
}

authorsRouter.post("/new", upload.single("image"), (req, res) => save(req, res, null));
authorsRouter.post("/bulk", async (req, res) => {
  const ids = [...new Set([].concat(req.body.ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const action = ["activate", "deactivate", "delete"].includes(req.body.action) ? req.body.action : "";
  if (!ids.length || !action) {
    req.session.flash = { type: "err", text: "Select at least one author first." };
    return res.redirect("/admin/authors");
  }
  if (action === "delete") await query("DELETE FROM authors WHERE id = ANY($1)", [ids]);
  else await query("UPDATE authors SET active = $2 WHERE id = ANY($1)", [ids, action === "activate"]);
  await audit(req, action, "authors", null, `${ids.length} authors`);
  await contentChanged();
  req.session.flash = { type: "ok", text: `${ids.length} authors ${action === "delete" ? "deleted (their stories keep the name)" : action + "d"}.` };
  res.redirect("/admin/authors");
});
authorsRouter.post("/:id/toggle", async (req, res) => {
  const a = await one("UPDATE authors SET active = NOT active WHERE id = $1 RETURNING name, active", [req.params.id]);
  if (a) {
    await audit(req, a.active ? "activate" : "deactivate", "authors", req.params.id, a.name);
    req.session.flash = { type: "ok", text: `${a.name} is now ${a.active ? "active" : "inactive"}.` };
  }
  res.redirect(req.get("referer") || "/admin/authors");
});
authorsRouter.post("/:id/delete", async (req, res) => {
  const a = await one("DELETE FROM authors WHERE id = $1 RETURNING name", [req.params.id]);
  if (a) {
    await audit(req, "delete", "authors", req.params.id, a.name);
    await contentChanged();
    req.session.flash = { type: "ok", text: `${a.name} deleted. Their stories keep the byline.` };
  }
  res.redirect("/admin/authors");
});
authorsRouter.post("/:id", upload.single("image"), (req, res) => save(req, res, Number(req.params.id)));
