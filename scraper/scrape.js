import ical from "ical-generator";
import fs from "node:fs";

const LOCATION = "yogasix-edgewater";

const STUDIO_TIMEZONE = "America/Denver";

// Format a Date into YYYY-MM-DD in the specified timezone
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

// Get the start of "today" (00:00) in Denver timezone
function startOfTodayInTZ(timeZone) {
  const localNow = new Date(
    new Date().toLocaleString("en-US", { timeZone })
  );

  localNow.setHours(0, 0, 0, 0);
  return localNow;
}


function getDateRange(days = 30) {
  const now = new Date();

  // Start = today in Denver time
  const start_date = ymdInTZ(now, STUDIO_TIMEZONE);

  // End = today + 30 days
  const end = new Date(now);
  end.setDate(end.getDate() + days);

  const end_date = ymdInTZ(end, STUDIO_TIMEZONE);

  return { start_date, end_date };
}


function parseDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Class type routing rules (based on event title text)
function classify(titleRaw = "") {
  const t = titleRaw.toLowerCase();

  // 1) Sculpt & Flow -> Sculpt (because sculpt hits first)
  if (t.includes("sculpt")) return "sculpt";

  // 2) Power & Flow -> Power
  if (t.includes("power")) return "power";

  if (t.includes("signature hot")) return "signature-hot";

  if (t.includes("restore") || t.includes("yin")) return "restore-yin";

  // Put Slow Flow before Flow so it doesn't get caught by "flow"
  if (t.includes("slow flow")) return "slow-flow";

  if (t.includes("mobility")) return "mobility";

  // Flow family (Flow / Hot Flow / Y6 Flow)
  if (t.includes("hot flow") || t.includes("y6 flow") || t.includes("flow")) return "flow";

  // Private sessions
  if (t.includes("private")) return "private";

  // Special Events
  if (t.includes("workshop") || t.includes("special event") || t.includes("teacher training"))
    return "special-events";

  // Other Classes
  if (t.includes("trx") || t.includes("prenatal") || t.includes("community class"))
    return "other-classes";

  // Everything else -> Other Classes
  return "other-classes";
}

function makeCalendar(name) {
  return ical({ name });
}

async function main() {
  const { start_date, end_date } = getDateRange(30);

  const url = `https://members.yogasix.com/api/v2/locations/${LOCATION}/schedule_entries?start_date=${start_date}&end_date=${end_date}`;
  console.log("Fetching schedule from:", url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Schedule API failed: ${res.status}`);

  const data = await res.json();
  const entries = Array.isArray(data) ? data : (data.schedule_entries || []);
  console.log("Classes found:", entries.length);

  // Master calendar (do not break existing functionality)
  const calAll = makeCalendar("YogaSix Edgewater — All Classes");

  // Type calendars
const cals = {
  sculpt: makeCalendar("YogaSix Edgewater — Sculpt"),
  power: makeCalendar("YogaSix Edgewater — Power"),
  "signature-hot": makeCalendar("YogaSix Edgewater — Signature Hot"),
  "restore-yin": makeCalendar("YogaSix Edgewater — Restore/Yin"),
  "slow-flow": makeCalendar("YogaSix Edgewater — Slow Flow"),
  mobility: makeCalendar("YogaSix Edgewater — Mobility"),

  flow: makeCalendar("YogaSix Edgewater — Flow"),
  "other-classes": makeCalendar("YogaSix Edgewater — Other Classes"),
  "special-events": makeCalendar("YogaSix Edgewater — Special Events"),
  private: makeCalendar("YogaSix Edgewater — Private"),
};


  let writtenAll = 0;
  const writtenByType = Object.fromEntries(Object.keys(cals).map(k => [k, 0]));
  let skipped = 0;

for (const c of entries) {
  const start = parseDate(c.starts_at);
  const end = parseDate(c.ends_at);

  if (!start || !end) {
    skipped++;
    continue;
  }

  // Only include events from today onward (Denver time)
  const todayStart = startOfTodayInTZ(STUDIO_TIMEZONE);
  if (start < todayStart) {
    continue; // skip anything before today
  }

  const title = c.title || "Yoga Class";
  const instructor = c.instructor?.name || "TBA";

  const spots =
    typeof c.free_spots === "number" ? `${c.free_spots} spots` : "spots n/a";

  const summary = `${title} — ${instructor} — ${spots}`;

  const description = [
    c.subtitle ? `Notes: ${c.subtitle}` : "",
    typeof c.capacity === "number" ? `Capacity: ${c.capacity}` : "",
    c.has_waitlist ? `Waitlist: ${c.waitlist_size ?? "yes"}` : "",
    c.booking_url ? `Book: ${c.booking_url}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Always add to master calendar
  calAll.createEvent({
    start,
    end,
    summary,
    description,
    location: "YogaSix Edgewater",
    url: c.booking_url || undefined,
  });
  writtenAll++;

  // Add to type calendar if matched
  const bucket = classify(title);
  if (cals[bucket]) {
    cals[bucket].createEvent({
      start,
      end,
      summary,
      description,
      location: "YogaSix Edgewater",
      url: c.booking_url || undefined,
    });
    writtenByType[bucket]++;
  }
}


  fs.mkdirSync("site", { recursive: true });

  // Existing output (keep name stable)
  fs.writeFileSync("site/yogasix-edgewater.ics", calAll.toString(), "utf8");

// Category outputs (for DAKboard color coding)
fs.writeFileSync("site/y6-sculpt.ics", cals.sculpt.toString(), "utf8");
fs.writeFileSync("site/y6-power.ics", cals.power.toString(), "utf8");
fs.writeFileSync("site/y6-signature-hot.ics", cals["signature-hot"].toString(), "utf8");
fs.writeFileSync("site/y6-restore-yin.ics", cals["restore-yin"].toString(), "utf8");
fs.writeFileSync("site/y6-slow-flow.ics", cals["slow-flow"].toString(), "utf8");
fs.writeFileSync("site/y6-mobility.ics", cals.mobility.toString(), "utf8");

fs.writeFileSync("site/y6-flow.ics", cals.flow.toString(), "utf8");
fs.writeFileSync("site/y6-other-classes.ics", cals["other-classes"].toString(), "utf8");
fs.writeFileSync("site/y6-special-events.ics", cals["special-events"].toString(), "utf8");
fs.writeFileSync("site/y6-private.ics", cals.private.toString(), "utf8");

  console.log("Events written (all):", writtenAll);
  console.log("Events written (by type):", writtenByType);
  console.log("Skipped:", skipped);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
