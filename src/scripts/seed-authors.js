// Adds the Wheelora writer team (safe to run again: existing names are skipped), then gives every story
// that has no author a random one. Edit names, photos and bios any time in the CMS under Authors.
import { one, query, rows } from "../db.js";
import { pickAuthor } from "../lib/authors.js";
import { slugify } from "../lib/text.js";

const TEAM = [
  ["Aarav Mehta", "Senior Auto Editor"], ["Riya Sharma", "Auto Correspondent"], ["Kabir Malhotra", "Road Test Editor"],
  ["Ananya Iyer", "Auto Correspondent"], ["Vihaan Kapoor", "News Editor"], ["Isha Verma", "Features Writer"],
  ["Rohan Deshmukh", "EV Correspondent"], ["Meera Nair", "Auto Correspondent"], ["Arjun Bhatia", "Senior Correspondent"],
  ["Sneha Kulkarni", "Reviews Writer"], ["Karan Singhania", "Industry Reporter"], ["Diya Menon", "Auto Correspondent"],
  ["Aditya Rao", "Launch Desk Editor"], ["Pooja Joshi", "Features Writer"], ["Siddharth Gupta", "Auto Analyst"],
  ["Nisha Reddy", "Auto Correspondent"], ["Varun Chopra", "Reviews Editor"], ["Tanvi Bansal", "News Reporter"],
  ["Yash Pillai", "Motoring Writer"], ["Kritika Saxena", "Auto Correspondent"], ["Harsh Vora", "Industry Reporter"],
  ["Simran Arora", "Features Writer"], ["Dev Banerjee", "Senior Auto Writer"], ["Naina Thakur", "News Reporter"],
];

for (const [name, designation] of TEAM) {
  const slug = slugify(name);
  if (await one("SELECT 1 FROM authors WHERE slug = $1", [slug])) continue;
  await query("INSERT INTO authors (name, slug, designation, bio, active) VALUES ($1,$2,$3,$4,true)", [name, slug, designation, `${name} writes about cars, launches and prices for Wheelora.`]);
}

let n = 0;
for (const a of await rows("SELECT id FROM articles WHERE author_id IS NULL")) {
  const p = await pickAuthor();
  await query("UPDATE articles SET author = $2, author_id = $3 WHERE id = $1", [a.id, p.name, p.id]);
  n++;
}
console.log(`Authors: ${(await one("SELECT count(*)::int AS n FROM authors")).n}. Stories given an author: ${n}.`);
process.exit(0);
