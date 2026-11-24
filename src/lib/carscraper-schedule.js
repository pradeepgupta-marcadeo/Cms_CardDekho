// Schedule maths for the CarScrapper tab. Times are India time (IST). No database here, so it is easy to test.
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const IST = 5.5 * HOUR;

export const FREQS = { hourly: "Every few hours", daily: "Every day", weekly: "Every week" };
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const parseTime = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? ""));
  return m ? [Number(m[1]), Number(m[2])] : [3, 0];
};

/** The latest planned start at or before `now` (ms) for a daily / weekly job; null for an hourly job. */
export function lastSlot(job, now) {
  if (job.freq !== "daily" && job.freq !== "weekly") return null;
  const [h, m] = parseTime(job.time);
  const ist = new Date(now + IST); // its UTC fields are the IST wall clock
  let slot = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), h, m) - IST;
  if (job.freq === "daily") return slot > now ? slot - DAY : slot;
  slot -= ((ist.getUTCDay() - Number(job.weekday ?? 0) + 7) % 7) * DAY;
  return slot > now ? slot - 7 * DAY : slot;
}

/** True when an enabled job should start now. A start missed while another scrape ran happens once, as soon as it is free. */
export function isDue(job, lastRun, now) {
  if (!job.enabled) return false;
  const ref = lastRun ?? job.createdAt ?? 0;
  if (job.freq === "hourly") return now - ref >= Math.max(1, Number(job.every) || 1) * HOUR;
  const slot = lastSlot(job, now);
  return slot !== null && ref < slot;
}

/** Next planned start (ms) for the screen. */
export function nextRun(job, lastRun, now) {
  if (!job.enabled) return null;
  if (isDue(job, lastRun, now)) return now;
  if (job.freq === "hourly") return (lastRun ?? job.createdAt ?? now) + Math.max(1, Number(job.every) || 1) * HOUR;
  return lastSlot(job, now) + (job.freq === "weekly" ? 7 * DAY : DAY);
}

/** Plain-language description, e.g. "Every Monday at 03:00 IST". */
export function describe(job) {
  if (job.freq === "hourly") return `Every ${job.every} hour${Number(job.every) === 1 ? "" : "s"}`;
  if (job.freq === "weekly") return `Every ${WEEKDAYS[job.weekday]} at ${job.time} IST`;
  return `Every day at ${job.time} IST`;
}

/** Checks a schedule form and returns a clean job, or throws a message for the editor. */
export function parseJob(body, modes) {
  const mode = String(body.mode ?? "");
  if (!modes[mode]) throw new Error("Choose what to scrape.");
  const freq = String(body.freq ?? "");
  if (!FREQS[freq]) throw new Error("Choose how often.");
  const time = String(body.time ?? "03:00");
  const [h, m] = parseTime(time);
  if (!/^\d{1,2}:\d{2}$/.test(time) || h > 23 || m > 59) throw new Error("Time must look like 03:00.");
  const every = Math.round(Number(body.every) || 0);
  if (freq === "hourly" && (every < 1 || every > 168)) throw new Error("Hours must be between 1 and 168.");
  const weekday = Math.round(Number(body.weekday) || 0);
  if (freq === "weekly" && (weekday < 0 || weekday > 6)) throw new Error("Choose a weekday.");
  return {
    mode,
    freq,
    time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
    every: freq === "hourly" ? every : null,
    weekday: freq === "weekly" ? weekday : null,
    options: parseOptions(body),
    enabled: true,
  };
}

/** Run options from a form: refresh, brand, limit, photos. */
export function parseOptions(body) {
  // Brand and city are typed freely (any case, other names, small typos); the job finds the real ones when it starts.
  const brand = String(body.brand ?? "").trim().replace(/\s+/g, " ");
  if (brand && !/^[\p{L}\p{N} .&'-]{1,40}$/u.test(brand)) throw new Error("Brand: use letters only, like Tata or Maruti Suzuki.");
  const city = String(body.city ?? "").trim().replace(/\s+/g, " ");
  if (city && !/^[\p{L}\p{N} ,.&'()-]{1,300}$/u.test(city)) throw new Error("City: use letters only, like Chandigarh or Pune, Jaipur.");
  const limit = body.limit === undefined || body.limit === "" ? null : Math.round(Number(body.limit));
  if (limit !== null && !(limit >= 1 && limit <= 5000)) throw new Error("Max must be between 1 and 5000.");
  const on = (v) => v === "on" || v === true || v === "true";
  return { refresh: on(body.refresh), brand: brand || null, city: city || null, limit, images: on(body.images) };
}

/** Command-line flags for scrape.py. Photos are copied by the CMS itself (Import photos), not by scrape.py. */
export function optionArgs(options = {}) {
  const args = [];
  if (options.refresh) args.push("--refresh");
  if (options.brand) args.push("--brand", options.brand);
  if (options.limit) args.push("--limit", String(options.limit));
  return args;
}
