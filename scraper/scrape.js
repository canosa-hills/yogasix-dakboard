import ical from "ical-generator";
import fs from "node:fs";

const LOCATION = "yogasix-edgewater";

// Helper: format YYYY-MM-DD
function formatDate(d) {
  return d.toISOString().split("T")[0];
}

// Build a rolling 7-day window
function getDateRange() {
  const start = new Date();
  const end = new Date();
  end.setDate(start.getDate() + 7);

  return {
    start_date: formatDate(start),
    end_date: formatDate(end),
  };
}

async function main() {
  const { start_date, end_date } = getDateRange();

  const url = `https://members.yogasix.com/api/v2/locations/${LOCATION}/schedule_entries?start_date=${start_date}&end_date=${end_date}`;

  console.log("Fetching schedule from:", url);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Schedule API failed: ${res.status}`);
  }

  const data = await res.json();

  if (!data || !data.schedule_entries) {
    throw new Error("No schedule_entries found in API response.");
  }

  const entries = data.schedule_entries;

  console.log("Classes found:", entries.length);

  // Create calendar
  const cal = ical({
    name: "YogaSix Edgewater — Public Schedule",
  });

  for (const c of entries) {
    const title = c.class_type?.name || "Yoga Class";
    const instructor = c.instructor?.name || "";
    const start = new Date(c.start_datetime);
    const end = new Date(c.end_datetime);

    cal.createEvent({
      start,
      end,
      summary: instructor ? `${title} — ${instructor}` : title,
      location: "YogaSix Edgewater",
      description: c.description || "",
    });
  }

  // Write ICS file for GitHub Pages
  fs.mkdirSync("site", { recursive: true });
  fs.writeFileSync("site/yogasix-edgewater.ics", cal.toString(), "utf8");

  console.log("ICS updated successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
