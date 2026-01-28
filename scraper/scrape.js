import ical from "ical-generator";
import fs from "node:fs";

const LOCATION = "yogasix-edgewater";

function formatDate(d) {
  return d.toISOString().split("T")[0];
}

function getDateRange(days = 30) {
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
  const { start_date, end_date } = getDateRange(30);

  const url = `https://members.yogasix.com/api/v2/locations/${LOCATION}/schedule_entries?start_date=${start_date}&end_date=${end_date}`;
  console.log("Fetching schedule from:", url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Schedule API failed: ${res.status}`);

  const data = await res.json();
  const entries = Array.isArray(data) ? data : (data.schedule_entries || []);
  console.log("Classes found:", entries.length);

  const cal = ical({ name: "YogaSix Edgewater — Next 30 Days" });

  let written = 0;

  for (const c of entries) {
    const start = parseDate(c.starts_at);
    const end = parseDate(c.ends_at);
    if (!start || !end) continue;

    const title = c.title || "Yoga Class";
    const instructor = c.instructor?.name || "TBA";

    // Open spots: use free_spots when present; otherwise show something neutral
    const spots =
      typeof c.free_spots === "number"
        ? `${c.free_spots} spots`
        : "spots n/a";

    // Put everything into SUMMARY for DAKboard
    const summary = `${title} — ${instructor} — ${spots}`;

    // Optional: keep richer details in DESCRIPTION (DAKboard may show on expand)
    const subtitle = c.subtitle ? `Notes: ${c.subtitle}` : "";
    const capacity = typeof c.capacity === "number" ? `Capacity: ${c.capacity}` : "";
    const waitlist = c.has_waitlist ? `Waitlist: ${c.waitlist_size ?? "yes"}` : "";

    const description = [subtitle, capacity, waitlist, c.booking_url ? `Book: ${c.booking_url}` : ""]
      .filter(Boolean)
      .join("\n");

    cal.createEvent({
      start,
      end,
      summary,
      description,
      location: "YogaSix Edgewater",
      url: c.booking_url || undefined
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
