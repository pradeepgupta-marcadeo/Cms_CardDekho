// Text tests the news scraper uses: is this the same story as another, and how much of a
// draft was lifted from its source. Thresholds follow the SportRadar CMS this was modelled on.

const STOP = new Set("the and for with from that this will after over into about says said new latest live price prices launch launched india indian car cars ahead what when your their they have has been more than also just".split(" "));

/** Distinctive words of a headline: lowercase, accents and punctuation gone, stop words dropped. */
export function keyWords(title) {
  return new Set(
    String(title ?? "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );
}

const shared = (a, b) => [...a].filter((w) => b.has(w)).length;

/** Two headlines about the same event: at least 60% of the shorter one's key words are in the other. */
export function sameEvent(a, b) {
  const A = keyWords(a);
  const B = keyWords(b);
  if (A.size < 3 || B.size < 3) return false;
  return shared(A, B) / Math.min(A.size, B.size) >= 0.6;
}

/** A headline matching an article we already hold: 4+ shared words, and a close overlap. */
export function sameHeadline(a, b) {
  const A = keyWords(a);
  const B = keyWords(b);
  const s = shared(A, B);
  if (s < 4) return false;
  const jaccard = s / (A.size + B.size - s);
  return jaccard >= 0.4 || s / Math.min(A.size, B.size) >= 0.6;
}

/**
 * Groups leads that are one story reported by several sources (newest first, within 36 hours,
 * at most 3 sources, never two from the same source). The first of each group is the lead.
 */
export function groupLeads(leads) {
  const sorted = [...leads].sort((a, b) => new Date(b.published_at ?? 0) - new Date(a.published_at ?? 0));
  const used = new Set();
  const groups = [];
  for (const lead of sorted) {
    if (used.has(lead.url)) continue;
    used.add(lead.url);
    const group = [lead];
    for (const other of sorted) {
      if (used.has(other.url) || group.length >= 3) continue;
      if (group.some((g) => g.source === other.source)) continue;
      const near = !lead.published_at || !other.published_at || Math.abs(new Date(lead.published_at) - new Date(other.published_at)) <= 36 * 3600 * 1000;
      if (near && sameEvent(lead.title, other.title)) {
        group.push(other);
        used.add(other.url);
      }
    }
    groups.push(group);
  }
  return groups;
}

const words = (text) =>
  String(text ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/["“”][^"“”]{10,}["“”]/g, " ") // quoted speech may be repeated
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Percentage of our 8-word runs that also appear in the source text. */
export function overlapPercent(ours, source, n = 8) {
  const mine = words(ours);
  const theirs = words(source);
  if (mine.length < n || theirs.length < n) return 0;
  const known = new Set();
  for (let i = 0; i <= theirs.length - n; i++) known.add(theirs.slice(i, i + n).join(" "));
  let hit = 0;
  let total = 0;
  for (let i = 0; i <= mine.length - n; i++) {
    total++;
    if (known.has(mine.slice(i, i + n).join(" "))) hit++;
  }
  return total ? (hit / total) * 100 : 0;
}

export const OVERLAP_LIMIT = 2.5;

const DAY = 24 * 3600 * 1000;
const GENERIC = new Set(
  (
    "launches launching upcoming coming soon models model suvs cars vehicles update updates details revealed reveal teased spotted spied testing tested expected rivals rival market sales units brand brands buyers buying guide today report reports month year news context features prices variants specs range official confirmed india's real world petrol diesel electric hybrid seven seater seat seats seater suv sedan hatchback compact which better money among including ahead against showcased showcase unveiled unveils debut debuts arrives arrival enters entry gets plans planned" +
    // brand names: two stories about different models of one brand are not the same story
    " maruti suzuki toyota tata motors hyundai mahindra honda skoda volkswagen renault nissan citroen jeep mercedes benz mercedes-benz audi volvo lexus porsche jaguar land rover mini byd vinfast kia"
  ).split(" "),
);
const MONTHS = /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/;
/**
 * The words that tell one story from another: distinctive headline words, plus short model codes ("D9", "XUV700",
 * "3XO") that the 4-letter rule would drop, and a code split by a space joined up ("Z9 GT" = "Z9GT").
 */
const storyWords = (title) => {
  const tokens = String(title ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().split(" ");
  const out = new Set([...keyWords(title)].filter((w) => !GENERIC.has(w) && !MONTHS.test(w) && !/^(19|20)\d\d$/.test(w)));
  const code = (w) => /\d/.test(w) && /[a-z]/.test(w);
  tokens.forEach((w, i) => {
    if (code(w)) out.add(w);
    const next = tokens[i + 1];
    if (next && (code(w) || code(next)) && w.length <= 3 && next.length <= 3) out.add(`${w}${next}`);
  });
  return out;
};

/**
 * Two stories about the same thing, so the second must not be written:
 *  - the headlines match (sameHeadline), or they describe one event (sameEvent), or
 *  - they are about the same car, in the same kind of story (launch, price, sales...), within three weeks:
 *    "Toyota Fortuner launch date set" and "Toyota Fortuner launch details" are one story told twice.
 * a and b: { title, carId?, category?, date? } (date: published or created).
 */
export function sameStory(a, b) {
  // Words every roundup shares ("launches", "november", "2026", "upcoming") say nothing about which story it is.
  const A = storyWords(a.title);
  const B = storyWords(b.title);
  const s = shared(A, B);
  if (s >= 2 && A.size >= 2 && B.size >= 2 && (s / Math.min(A.size, B.size) >= 0.6 || (s >= 4 && s / (A.size + B.size - s) >= 0.4))) return true;
  if (!a.carId || a.carId !== b.carId || !a.category || a.category !== b.category) return false;
  if (!a.date || !b.date) return true;
  return Math.abs(new Date(a.date) - new Date(b.date)) <= 21 * DAY;
}

/** Two pieces of text that repeat each other: more than 8% of their 8-word runs are the same. */
export const sameText = (a, b) => overlapPercent(a, b) > 8;
