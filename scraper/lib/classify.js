// Shared class-title classification, used by both the ICS generator (scrape.js) and the
// Google Calendar sync (sync-google-calendar.js) so DakBoard's per-category feeds and the
// Google Calendar entries never drift apart.
export function classify(titleRaw = "") {
  const t = titleRaw.toLowerCase();

  // TRX and community classes read as special events/workshops, same as the studio's actual
  // workshops/trainings — they don't belong in a generic "other" bucket.
  if (
    t.includes("workshop") ||
    t.includes("special") ||
    t.includes("teacher training") ||
    t.includes("trx") ||
    t.includes("community")
  ) {
    return "special-events";
  }

  if (t.includes("private")) return "private";

  if (t.includes("sculpt")) return "sculpt";
  if (t.includes("power")) return "power";
  if (t.includes("signature hot")) return "signature-hot";
  if (t.includes("restore") || t.includes("yin")) return "restore-yin";
  if (t.includes("slow flow")) return "slow-flow";
  if (t.includes("mobility")) return "mobility";

  // Any other flow variant (hot flow, y6 flow, etc.) falls under the general Flow bucket.
  if (t.includes("flow")) return "flow";

  return "other-classes";
}

// Category metadata shared by the ICS generator: one calendar/file per bucket so DakBoard can
// subscribe to each separately and color-code it.
export const CATEGORY_META = [
  { key: "special-events", label: "Special Events / Workshops", file: "y6-special-events.ics" },
  { key: "private", label: "Private Events", file: "y6-private.ics" },
  { key: "sculpt", label: "Sculpt", file: "y6-sculpt.ics" },
  { key: "power", label: "Power", file: "y6-power.ics" },
  { key: "signature-hot", label: "Signature Hot", file: "y6-signature-hot.ics" },
  { key: "restore-yin", label: "Restore/Yin", file: "y6-restore-yin.ics" },
  { key: "slow-flow", label: "Slow Flow", file: "y6-slow-flow.ics" },
  { key: "mobility", label: "Mobility", file: "y6-mobility.ics" },
  { key: "flow", label: "Flow", file: "y6-flow.ics" },
  { key: "other-classes", label: "Other", file: "y6-other-classes.ics" },
];

// Google Calendar event colorId per category, chosen to match the colors already assigned to
// each per-category ICS feed in DakBoard, so the single synced Google Calendar (viewed natively
// in DakBoard, not as an ICS subscription) shows the same color-coding per event.
// Reference: https://developers.google.com/calendar/api/v3/reference/colors
//   1 Lavender, 2 Sage, 3 Grape, 4 Flamingo, 5 Banana, 6 Tangerine,
//   7 Peacock, 8 Graphite, 9 Blueberry, 10 Basil, 11 Tomato
export const CATEGORY_COLOR_IDS = {
  sculpt: "11", // Tomato — red
  power: "5", // Banana — yellow/gold
  "signature-hot": "6", // Tangerine — orange
  "restore-yin": "9", // Blueberry — blue
  "slow-flow": "2", // Sage — green
  mobility: "4", // Flamingo — pink
  flow: "7", // Peacock — teal/blue
  "other-classes": "8", // Graphite — gray
  "special-events": "3", // Grape — purple
  private: "1", // Lavender — light gray/purple
};
