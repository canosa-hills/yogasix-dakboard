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
