import bcrypt from "bcryptjs";
import { Router } from "express";
import { one, query } from "../db.js";
import { clearLoginTries, loginLimiter } from "../lib/auth.js";

export const authRouter = Router();

const safeNext = (n) => (typeof n === "string" && n.startsWith("/admin") && !n.startsWith("//") ? n : "/admin");

authRouter.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/admin");
  res.render("login", { error: null, next: safeNext(req.query.next), email: "" });
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  const email = String(req.body.email ?? "").trim().toLowerCase();
  const password = String(req.body.password ?? "");
  const user = await one("SELECT * FROM users WHERE email = $1", [email]);
  const ok = user && (await bcrypt.compare(password, user.password_hash));
  if (!ok) return res.status(401).render("login", { error: "Email or password is wrong.", next: safeNext(req.body.next), email });
  clearLoginTries(req.ip);
  await query("UPDATE users SET last_login = now() WHERE id = $1", [user.id]);
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role };
    req.session.save(() => res.redirect(safeNext(req.body.next)));
  });
});

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});
