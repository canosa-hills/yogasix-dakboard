import ical from "ical-generator";
import fs from "node:fs";

const LOCATION = "yogasix-edgewater";
const STUDIO_TIMEZONE = "America/Denver";

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

// ---------- Classification / calendars ----------
// You can expand this later; this keeps your existing behavior intact.
function classify(titleRaw = "") {
  const t = titleRaw.toLowerCase();

  if (t.includes("sculpt")) return "sculpt";
  if (t.includes("power")) return "power";
  if (t.includes("signature hot")) return "signature-hot";
  if (t.includes("restore") || t.includes("yin")) return "restore-yin";
  if (t.includes("slow flow")) return "slow-flow";
  if (t.includes("mobility")) return "mobility";

  return "other";
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
  console.log("Fetching schedule from:", url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Schedule API failed: ${res.status}`);

  const data = await res.json();
  // API sometimes returns array, sometimes object
  return Array.isArray(data) ? data : (data.schedule_entries || []);
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

  let entries;

  if (MODE === "spots") {
    console.log("MODE=spots: loading cached schedule...");
    if (!fs.existsSync(CACHE_FILE)) {
      console.log("Cache not found yet. Falling back to full fetch once.");
      entries = await fetchSchedule(start_date, end_date);
      writeCache(entries);
    } else {
      entries = readCache();
      entries = await refreshSpotsFromLive(entries, start_date, end_date);
      // keep cache up to date with new spots
      writeCache(entries);
    }
  } else {
    console.log("MODE=full: fetching schedule and writing cache...");
    entries = await fetchSchedule(start_date, end_date);
    writeCache(entries);
  }

  console.log("Classes loaded:", entries.length);

  const todayStart = startOfTodayInTZ(STUDIO_TIMEZONE);

  // Master calendar (stable filename)
  const calAll = makeCalendar("YogaSix Edgewater — All Classes");

  // Type calendars (stable filenames)
  const cals = {
    sculpt: makeCalendar("YogaSix Edgewater — Sculpt"),
    power: makeCalendar("YogaSix Edgewater — Power"),
    "signature-hot": makeCalendar("YogaSix Edgewater — Signature Hot"),
    "restore-yin": makeCalendar("YogaSix Edgewater — Restore/Yin"),
    "slow-flow": makeCalendar("YogaSix Edgewater — Slow Flow"),
    mobility: makeCalendar("YogaSix Edgewater — Mobility"),
    other: makeCalendar("YogaSix Edgewater — Other"),
  };

  let writtenAll = 0;
  const writtenByType = Object.fromEntries(Object.keys(cals).map((k) => [k, 0]));
  let skippedBadDates = 0;
  let skippedPast = 0;

  for (const c of entries) {
    const start = parseDate(c.starts_at);
    const end = parseDate(c.ends_at);
    if (!start || !end) {
      skippedBadDates++;
      continue;
    }

    // Only include events from today onward (Denver)
    if (start < todayStart) {
      skippedPast++;
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

    // Type calendar
    const bucket = classify(title);
    const target = cals[bucket] ? bucket : "other";

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
  fs.writeFileSync("site/y6-sculpt.ics", cals.sculpt.toString(), "utf8");
  fs.writeFileSync("site/y6-power.ics", cals.power.toString(), "utf8");
  fs.writeFileSync("site/y6-signature-hot.ics", cals["signature-hot"].toString(), "utf8");
  fs.writeFileSync("site/y6-restore-yin.ics", cals["restore-yin"].toString(), "utf8");
  fs.writeFileSync("site/y6-slow-flow.ics", cals["slow-flow"].toString(), "utf8");
  fs.writeFileSync("site/y6-mobility.ics", cals.mobility.toString(), "utf8");
  fs.writeFileSync("site/y6-other.ics", cals.other.toString(), "utf8");

  console.log("Events written (all):", writtenAll);
  console.log("Events written (by type):", writtenByType);
  console.log("Skipped (bad dates):", skippedBadDates);
  console.log("Skipped (past before today Denver):", skippedPast);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
