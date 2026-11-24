// Generic list / create / edit / delete screens for the simple content types in lib/resources.js.
import { Router } from "express";
import { one, query, rows } from "../db.js";
import { audit, contentChanged } from "../lib/publish.js";
import { RESOURCES } from "../lib/resources.js";
import { slugify, toList } from "../lib/text.js";

export const crudRouter = Router();
const PAGE = 50;

const ident = (s) => {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(s)) throw new Error(`Bad identifier ${s}`);
  return s;
};

export async function fieldOptions(fields) {
  const out = {};
  for (const f of fields) if (f.type === "fk") out[f.name] = await rows(f.sql);
  return out;
}

export function parseValue(f, raw) {
  if (f.type === "bool") return raw === "on" || raw === "true" || raw === true;
  if (raw === undefined || raw === null) return null;
  const v = typeof raw === "string" ? raw.trim() : raw;
  switch (f.type) {
    case "number":
    case "fk":
      return v === "" ? null : Number.parseInt(v, 10);
    case "decimal":
      return v === "" ? null : Number(v);
    case "tags":
      return toList(v);
    case "json":
      if (v === "") return f.default ?? null;
      return JSON.parse(v);
    case "image":
      return v ? (String(v).startsWith("{") ? JSON.parse(v) : { src: v, w: 512, h: 256 }) : null;
    case "slug":
      return slugify(v);
    case "date":
      return v || null;
    default:
      return v;
  }
}

export function collect(def, body) {
  const values = {};
  const errors = [];
  for (const f of def.fields) {
    if (f.readonly) continue;
    try {
      let v = parseValue(f, body[f.name]);
      if (f.type === "slug" && !v && f.from) v = slugify(body[f.from]);
      if (f.required && (v === null || v === "" || (Array.isArray(v) && !v.length))) errors.push(`${f.label} is required.`);
      if (f.type === "number" && v !== null && Number.isNaN(v)) errors.push(`${f.label} must be a number.`);
      values[f.name] = v;
    } catch {
      errors.push(`${f.label}: not valid JSON. Check the brackets and quotes.`);
    }
  }
  return { values: { ...values, ...(def.fixed ?? {}) }, errors };
}

const toDb = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v);

crudRouter.get("/:name", async (req, res, next) => {
  const def = RESOURCES[req.params.name];
  if (!def) return next();
  const pk = def.pk ?? "id";
  const page = Math.max(1, Number(req.query.page ?? 1));
  const q = String(req.query.q ?? "").trim();
  const where = [def.where].filter(Boolean);
  const params = [];
  if (q && def.search?.length) {
    params.push(`%${q}%`);
    where.push(`(${def.search.map((c) => `${ident(c.includes(".") ? c : `t.${c}`)}::text ILIKE $${params.length}`).join(" OR ")})`);
  }
  if (req.query.demo === "1") where.push("t.is_demo");
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (await one(`SELECT count(*)::int AS n FROM ${ident(def.table)} t ${def.join ?? ""} ${w}`, params)).n;
  const list = await rows(
    `SELECT t.*${def.selectExtra ? `, ${def.selectExtra}` : ""} FROM ${ident(def.table)} t ${def.join ?? ""} ${w} ORDER BY ${def.order.split(",").map((o) => `t.${o.trim()}`).join(", ")} LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`,
    params,
  );
  res.render("list", { def, name: req.params.name, list, pk, total, page, pages: Math.ceil(total / PAGE), q, title: def.title });
});

crudRouter.get("/:name/new", async (req, res, next) => {
  const def = RESOURCES[req.params.name];
  if (!def || def.noCreate) return next();
  const row = Object.fromEntries(def.fields.map((f) => [f.name, f.default ?? (f.type === "bool" ? false : "")]));
  res.render("form", { def, name: req.params.name, row, isNew: true, options: await fieldOptions(def.fields), errors: [], title: `New ${def.singular}` });
});

crudRouter.get("/:name/:id", async (req, res, next) => {
  const def = RESOURCES[req.params.name];
  if (!def) return next();
  const row = await one(`SELECT * FROM ${ident(def.table)} t WHERE t.${ident(def.pk ?? "id")} = $1`, [req.params.id]);
  if (!row) return next();
  res.render("form", { def, name: req.params.name, row, isNew: false, options: await fieldOptions(def.fields), errors: [], title: `Edit ${def.singular}` });
});

crudRouter.post("/:name", async (req, res, next) => {
  const def = RESOURCES[req.params.name];
  if (!def || def.noCreate) return next();
  const { values, errors } = collect(def, req.body);
  if (errors.length) return res.status(400).render("form", { def, name: req.params.name, row: { ...req.body, ...values }, isNew: true, options: await fieldOptions(def.fields), errors, title: `New ${def.singular}` });
  const cols = Object.keys(values);
  try {
    const r = await one(`INSERT INTO ${ident(def.table)} (${cols.map(ident).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${ident(def.pk ?? "id")} AS pk`, cols.map((c) => toDb(values[c])));
    await audit(req, "create", req.params.name, r.pk);
    await contentChanged();
    req.session.flash = { type: "ok", text: `Saved. The website updates in a few seconds.` };
    res.redirect(`/admin/r/${req.params.name}/${encodeURIComponent(r.pk)}`);
  } catch (err) {
    res.status(400).render("form", { def, name: req.params.name, row: { ...req.body, ...values }, isNew: true, options: await fieldOptions(def.fields), errors: [friendly(err)], title: `New ${def.singular}` });
  }
});

crudRouter.post("/:name/:id", async (req, res, next) => {
  const def = RESOURCES[req.params.name];
  if (!def) return next();
  const { values, errors } = collect(def, req.body);
  const pk = ident(def.pk ?? "id");
  if (errors.length) return res.status(400).render("form", { def, name: req.params.name, row: { ...req.body, ...values, [pk]: req.params.id }, isNew: false, options: await fieldOptions(def.fields), errors, title: `Edit ${def.singular}` });
  const cols = Object.keys(values);
  const hasUpdated = ["brands", "cities", "offers", "dealers", "stations", "fuel_prices"].includes(def.table);
  try {
    await query(`UPDATE ${ident(def.table)} SET ${cols.map((c, i) => `${ident(c)} = $${i + 2}`).join(", ")}${hasUpdated ? ", updated_at = now()" : ""} WHERE ${pk} = $1`, [req.params.id, ...cols.map((c) => toDb(values[c]))]);
    await audit(req, "update", req.params.name, req.params.id);
    await contentChanged();
    req.session.flash = { type: "ok", text: "Saved. The website updates in a few seconds." };
    res.redirect(`/admin/r/${req.params.name}/${encodeURIComponent(values[def.pk ?? "id"] ?? req.params.id)}`);
  } catch (err) {
    res.status(400).render("form", { def, name: req.params.name, row: { ...req.body, ...values, [pk]: req.params.id }, isNew: false, options: await fieldOptions(def.fields), errors: [friendly(err)], title: `Edit ${def.singular}` });
  }
});

crudRouter.post("/:name/:id/delete", async (req, res, next) => {
  const def = RESOURCES[req.params.name];
  if (!def || def.noCreate) return next();
  await query(`DELETE FROM ${ident(def.table)} WHERE ${ident(def.pk ?? "id")} = $1`, [req.params.id]);
  await audit(req, "delete", req.params.name, req.params.id);
  await contentChanged();
  req.session.flash = { type: "ok", text: `Deleted.` };
  res.redirect(`/admin/r/${req.params.name}`);
});

export function friendly(err) {
  if (err.code === "23505") return "Another item already uses this value (URL slug or name). Choose a different one.";
  if (err.code === "23503") return "This refers to something that does not exist, or other items still use it.";
  if (err.code === "23514") return "One of the values is not allowed. Check the dropdowns.";
  return err.message;
}
