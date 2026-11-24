import path from "node:path";
import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import { one, query, rows } from "../db.js";
import { audit, contentChanged } from "../lib/publish.js";
import { putFile } from "../lib/storage.js";
import { slugify } from "../lib/text.js";

export const mediaRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|svg\+xml)$/.test(file.mimetype)) });

// Every upload is resized to at most 1600px wide and saved as WebP, so pages stay fast (LCP).
export async function saveImage(file, { alt = "", credit = "" } = {}) {
  const now = new Date();
  const folder = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`;
  let url;
  const base = `${slugify(path.parse(file.originalname).name).slice(0, 50) || "image"}-${Date.now().toString(36)}`;
  let filename;
  let w;
  let h;
  let bytes;
  if (file.mimetype === "image/svg+xml") {
    const svg = file.buffer.toString("utf8");
    if (/<script|on\w+=|javascript:/i.test(svg)) throw new Error("This SVG contains scripts and was rejected.");
    filename = `${base}.svg`;
    url = await putFile(`${folder}/${filename}`, Buffer.from(svg, "utf8"), "image/svg+xml");
    const meta = await sharp(file.buffer).metadata().catch(() => ({ width: 512, height: 256 }));
    [w, h, bytes] = [meta.width ?? 512, meta.height ?? 256, file.size];
  } else {
    filename = `${base}.webp`;
    const { data, info: out } = await sharp(file.buffer).rotate().resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    url = await putFile(`${folder}/${filename}`, data, "image/webp");
    [w, h, bytes] = [out.width, out.height, out.size];
  }
  return one("INSERT INTO media (filename, url, w, h, bytes, alt, credit) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *", [filename, url, w, h, bytes, alt, credit]);
}

mediaRouter.get("/", async (req, res) => {
  const list = await rows("SELECT * FROM media ORDER BY id DESC LIMIT 200");
  if (req.query.format === "json") return res.json(list);
  res.render("media", { title: "Media library", list });
});

mediaRouter.post("/upload", upload.single("file"), async (req, res) => {
  const wantsJson = req.accepts(["html", "json"]) === "json";
  if (!req.file) {
    if (wantsJson) return res.status(400).json({ error: "Choose a JPG, PNG, WebP or SVG image under 15 MB." });
    req.session.flash = { type: "err", text: "Choose a JPG, PNG, WebP or SVG image under 15 MB." };
    return res.redirect(req.get("referer") || "/admin/media");
  }
  try {
    const m = await saveImage(req.file, { alt: req.body.alt ?? "", credit: req.body.credit ?? "" });
    await audit(req, "upload", "media", m.id, m.filename);
    if (req.query.car) {
      const n = (await one("SELECT COALESCE(max(sort), -1) + 1 AS n FROM photos WHERE car_id = $1", [req.query.car])).n;
      await query("INSERT INTO photos (car_id, src, w, h, kind, credit, license, page, sort) VALUES ($1,$2,$3,$4,$5,$6,'All rights reserved','',$7)", [req.query.car, m.url, m.w, m.h, req.body.kind || "front", req.body.credit || "Wheelora", n]);
      await contentChanged();
      req.session.flash = { type: "ok", text: `Uploaded (${Math.round(m.bytes / 1024)} KB after compression) and added to the car.` };
      return res.redirect(`/admin/cars/${req.query.car}/photos`);
    }
    if (wantsJson) return res.json(m);
    req.session.flash = { type: "ok", text: `Uploaded ${m.filename} (${Math.round(m.bytes / 1024)} KB).` };
    res.redirect("/admin/media");
  } catch (err) {
    if (wantsJson) return res.status(400).json({ error: err.message });
    req.session.flash = { type: "err", text: err.message };
    res.redirect(req.get("referer") || "/admin/media");
  }
});
