import ical from "ical-generator";
import fs from "node:fs";

const LOCATION = "yogasix-edgewater";

function formatDate(d) {
  return d.toISOString().split("T")[0];
}

function getDateRange(days = 7) {
  const start = new Date();
  const end = new Date();
  end.setDate(start.getDate() + days);
  return { start_date: formatDate(start), end_date: formatDate(end) };
}

function parseDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function main() {
  const { start_date, end_date } = getDateRange(7);

  const url = `https://members.yogasix.com/api/v2/locations/${LOCATION}/schedule_entries?start_date=${start_date}&end_date=${end_date}`;
  console.log("Fetching schedule from:", url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Schedule API failed: ${res.status}`);

  const data = await res.json();
  const entries = Array.isArray(data) ? data : (data.schedule_entries || []);

  console.log("Classes found:", entries.length);

  const cal = ical({
    name: "YogaSix Edgewater — Public Schedule"
  });

  let written = 0;

  for (const c of entries) {
    const start = parseDate(c.starts_at);
    const end = parseDate(c.ends_at);
    if (!start || !end) continue;

    // Title and instructor are explicit in this API
    const title = c.title || "Yoga Class";
    const subtitle = c.subtitle || ""; // often contains format/level notes
    const instructorName = c.instructor?.name || "";

    // Helpful details for DAKboard display
    const spots = (typeof c.free_spots === "number") ? `Free spots: ${c.free_spots}` : "";
    const waitlist = c.has_waitlist ? `Waitlist: ${c.waitlist_size ?? "yes"}` : "";
    const details = [subtitle, instructorName && `Instructor: ${instructorName}`, spots, waitlist]
      .filter(Boolean)
      .join("\n");

    // Keep the summary short and scannable
    const summary = instructorName ? `${title} — ${instructorName}` : title;

    cal.createEvent({
      start,
      end,
      summary,
      description: details || c.description || "",
      url: c.booking_url || undefined,
      location: "YogaSix Edgewater"
    });

    written++;
  }

  fs.mkdirSync("site", { recursive: true });
  fs.writeFileSync("site/yogasix-edgewater.ics", cal.toString(), "utf8");

  console.log(`Events written: ${written}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
