import ical from "ical-generator";
import fs from "node:fs";

const LOCATION = "yogasix-edgewater";

function formatDate(d) {
  return d.toISOString().split("T")[0];
}

function getDateRange() {
  const start = new Date();
  const end = new Date();
  end.setDate(start.getDate() + 7);
  return { start_date: formatDate(start), end_date: formatDate(end) };
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k]) return obj[k];
  }
  return null;
}

async function main() {
  const { start_date, end_date } = getDateRange();

  const url = `https://members.yogasix.com/api/v2/locations/${LOCATION}/schedule_entries?start_date=${start_date}&end_date=${end_date}`;
  console.log("Fetching schedule from:", url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Schedule API failed: ${res.status}`);

  const data = await res.json();

  // The API might return either {schedule_entries:[...]} or just [...]
  const entries = Array.isArray(data) ? data : (data.schedule_entries || []);
  console.log("Classes found:", entries.length);

  if (entries.length) {
    console.log("Sample entry keys:", Object.keys(entries[0]));
  }

  const cal = ical({ name: "YogaSix Edgewater — Public Schedule" });

  let written = 0;
  let skipped = 0;

  for (const c of entries) {
    // Try common datetime field variants
    const startRaw = pick(c, ["start_datetime", "startDateTime", "start_at", "starts_at", "start"]);
    const endRaw = pick(c, ["end_datetime", "endDateTime", "end_at", "ends_at", "end"]);

    const start = parseDate(startRaw);
    const end = parseDate(endRaw) || (start ? new Date(start.getTime() + 60 * 60 * 1000) : null);

    if (!start || !end) {
      skipped++;
      continue;
    }

    // Try common title/instructor shapes
    const title =
      c.class_type?.name ||
      c.classType?.name ||
      c.class_name ||
      c.name ||
      "Yoga Class";

    const instructor =
      c.instructor?.name ||
      c.teacher?.name ||
      c.instructor_name ||
      "";

    cal.createEvent({
      start,
      end,
      summary: instructor ? `${title} — ${instructor}` : title,
      location: "YogaSix Edgewater"
    });

    written++;
  }

  fs.mkdirSync("site", { recursive: true });
  fs.writeFileSync("site/yogasix-edgewater.ics", cal.toString(), "utf8");

  console.log(`Events written: ${written} | skipped (bad dates): ${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
