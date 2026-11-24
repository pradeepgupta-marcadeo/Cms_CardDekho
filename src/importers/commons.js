// Finds freely licensed car photos on Wikimedia Commons. Only licences that
// allow commercial reuse are returned; every photo keeps its author credit.
import { getJson } from "../lib/http.js";

const API = "https://commons.wikimedia.org/w/api.php";
const OK = /^(cc[ -]by(-sa)?[ -]?[234]\.0|cc0|public domain|pd)/i;
const strip = (s) => String(s ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

export function kindFromTitle(title) {
  const t = title.toLowerCase();
  if (/interior|dashboard|cabin|cockpit|steering/.test(t)) return "interior";
  if (/rear|back|heck/.test(t)) return "rear";
  if (/side|profile/.test(t)) return "side";
  return "front";
}

export async function searchCommons(term, { limit = 24 } = {}) {
  const url = `${API}?${new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `${term} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: String(limit),
    prop: "imageinfo",
    iiprop: "url|size|extmetadata",
    iiurlwidth: "1280",
    origin: "*",
  })}`;
  const json = await getJson(url, { timeout: 30000 });
  const pages = Object.values(json.query?.pages ?? {});
  return pages
    .map((p) => {
      const ii = p.imageinfo?.[0];
      const meta = ii?.extmetadata ?? {};
      const license = strip(meta.LicenseShortName?.value);
      return {
        title: p.title,
        src: ii?.thumburl ?? ii?.url,
        w: ii?.thumbwidth ?? ii?.width,
        h: ii?.thumbheight ?? ii?.height,
        page: ii?.descriptionurl,
        credit: strip(meta.Artist?.value) || "Wikimedia Commons contributor",
        license,
        kind: kindFromTitle(p.title),
        // Words around the photo, used to tell which colour of the car it shows.
        text: [p.title, strip(meta.ImageDescription?.value), strip(meta.Categories?.value).replace(/\|/g, " ")].join(" "),
        landscape: (ii?.width ?? 0) > (ii?.height ?? 0),
      };
    })
    .filter((p) => p.src && p.landscape && p.w >= 800 && OK.test(p.license));
}
