import ical from "ical-generator";
import fs from "node:fs";
import { classify, CATEGORY_META } from "./lib/classify.js";

const LOCATION = "yogasix-edgewater";
const STUDIO_TIMEZONE = "America/Denver";
const FETCH_RETRIES = 3;
const FETCH_RETRY_DELAY_MS = 2000;

// MODE:
// - "full"  = fetch schedule + write cache + generate ICS
// - "spots" = load cached schedule + refresh live free_spots + generate ICS
const MODE = process.env.MODE || "full";

// ---------- Time helpers ----------
function ymdInTZ(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function startOfTodayInTZ(timeZone) {
  const localNow = new Date(new Date().toLocaleString("en-US", { timeZone }));
  localNow.setHours(0, 0, 0, 0);
  return localNow;
}

function getDateRange(days = 30) {
  const now = new Date();
  const start_date = ymdInTZ(now, STUDIO_TIMEZONE);

  const end = new Date(now);
  end.setDate(end.getDate() + days);
  const end_date = ymdInTZ(end, STUDIO_TIMEZONE);

  return { start_date, end_date };
}

function parseDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeCalendar(name) {
  return ical({ name });
}

// ---------- Cache / I/O ----------
const CACHE_DIR = "cache";
const CACHE_FILE = `${CACHE_DIR}/schedule.json`;

function ensureDirs() {
  fs.mkdirSync("site", { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Keep only classes starting today or later (Denver), so the cache never grows unbounded and
// the spots-only refresh only ever touches current/future classes.
function pruneToTodayForward(entries, todayStart) {
  return entries.filter((e) => {
    const start = parseDate(e.starts_at);
    return start && start >= todayStart;
  });
}

function writeCache(entries) {
  ensureDirs();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(entries, null, 2), "utf8");
}

function readCache() {
  const raw = fs.readFileSync(CACHE_FILE, "utf8");
  return JSON.parse(raw);
}

// ---------- API fetch ----------
async function fetchSchedule(start_date, end_date) {
  const url = `https://members.yogasix.com/api/v2/locations/${LOCATION}/schedule_entries?start_date=${start_date}&end_date=${end_date}`;

  let lastErr;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      console.log(`Fetching schedule from (attempt ${attempt}/${FETCH_RETRIES}):`, url);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Schedule API failed: ${res.status}`);

      const data = await res.json();
      // API sometimes returns array, sometimes object
      return Array.isArray(data) ? data : (data.schedule_entries || []);
    } catch (err) {
      lastErr = err;
      console.error(`Fetch attempt ${attempt} failed:`, err.message);
      if (attempt < FETCH_RETRIES) await sleep(FETCH_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastErr;
}

// In "spots" mode, we re-fetch the same date window, then map free_spots/capacity/waitlist fields
// back onto the cached entries by id.
async function refreshSpotsFromLive(entriesCached, start_date, end_date) {
  console.log("Refreshing spots only from live API window...");
  const live = await fetchSchedule(start_date, end_date);

  const byId = new Map(live.map((e) => [e.id, e]));

  let updated = 0;
  let missing = 0;

  for (const e of entriesCached) {
    const liveEntry = byId.get(e.id);
    if (!liveEntry) {
      missing++;
      continue;
    }

    // Only overwrite the “volatile” fields
    e.free_spots = liveEntry.free_spots;
    e.capacity = liveEntry.capacity;
    e.has_waitlist = liveEntry.has_waitlist;
    e.waitlist_size = liveEntry.waitlist_size;
    e.waitlist_until = liveEntry.waitlist_until;

    updated++;
  }

  console.log(`Spot refresh: updated=${updated}, missing_in_live_window=${missing}`);
  return entriesCached;
}

// ---------- Main ----------
async function main() {
  ensureDirs();

  const { start_date, end_date } = getDateRange(30);
  const todayStart = startOfTodayInTZ(STUDIO_TIMEZONE);

  let entries;

  if (MODE === "spots") {
    console.log("MODE=spots: loading cached schedule...");
    if (!fs.existsSync(CACHE_FILE)) {
      console.log("Cache not found yet. Falling back to full fetch once.");
      entries = await fetchSchedule(start_date, end_date);
    } else {
      entries = readCache();
      entries = await refreshSpotsFromLive(entries, start_date, end_date);
    }
  } else {
    console.log("MODE=full: fetching schedule and writing cache...");
    entries = await fetchSchedule(start_date, end_date);
  }

  // Prune past entries before persisting the cache so it doesn't grow unbounded, and so the
  // spots-only refresh above never carries stale classes forward.
  entries = pruneToTodayForward(entries, todayStart);
  writeCache(entries);

  console.log("Classes loaded:", entries.length);

  // Master calendar (stable filename)
  const calAll = makeCalendar("YogaSix Edgewater — All Classes");

  // Category calendars (stable filenames), driven by the shared classify() category list
  const cals = Object.fromEntries(
    CATEGORY_META.map(({ key, label }) => [key, makeCalendar(`YogaSix Edgewater — ${label}`)])
  );

  let writtenAll = 0;
  const writtenByType = Object.fromEntries(CATEGORY_META.map(({ key }) => [key, 0]));
  let skippedBadDates = 0;

  for (const c of entries) {
    const start = parseDate(c.starts_at);
    const end = parseDate(c.ends_at);
    if (!start || !end) {
      skippedBadDates++;
      continue;
    }

    const title = c.title || "Yoga Class";
    const instructor = c.instructor?.name || "TBA";
    const spots = typeof c.free_spots === "number" ? `${c.free_spots} spots` : "spots n/a";
    const summary = `${title} — ${instructor} — ${spots}`;

    const description = [
      c.subtitle ? `Notes: ${c.subtitle}` : "",
      typeof c.capacity === "number" ? `Capacity: ${c.capacity}` : "",
      c.has_waitlist ? `Waitlist: ${c.waitlist_size ?? "yes"}` : "",
      c.booking_url ? `Book: ${c.booking_url}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    // Master calendar
    calAll.createEvent({
      start,
      end,
      summary,
      description,
      location: "YogaSix Edgewater",
      url: c.booking_url || undefined,
    });
    writtenAll++;

    // Category calendar
    const bucket = classify(title);
    const target = cals[bucket] ? bucket : "other-classes";

    cals[target].createEvent({
      start,
      end,
      summary,
      description,
      location: "YogaSix Edgewater",
      url: c.booking_url || undefined,
    });
    writtenByType[target]++;
  }

  // Write outputs (stable filenames)
  fs.writeFileSync("site/yogasix-edgewater.ics", calAll.toString(), "utf8");
  for (const { key, file } of CATEGORY_META) {
    fs.writeFileSync(`site/${file}`, cals[key].toString(), "utf8");
  }

  console.log("Events written (all):", writtenAll);
  console.log("Events written (by type):", writtenByType);
  console.log("Skipped (bad dates):", skippedBadDates);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
