import fs from "node:fs";
import crypto from "node:crypto";
import { google } from "googleapis";

const LOCATION = "yogasix-edgewater";
const STUDIO_TIMEZONE = "America/Denver";

// Secrets (GitHub Actions)
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const GOOGLE_REFRESH_TOKEN = (process.env.GOOGLE_REFRESH_TOKEN || "").trim();

// IMPORTANT: calendarId is frequently broken by invisible whitespace/newlines.
// We trim AND URL-encode before passing to the API.
const GOOGLE_CALENDAR_ID_RAW = process.env.GOOGLE_CALENDAR_ID || "";
const GOOGLE_CALENDAR_ID = GOOGLE_CALENDAR_ID_RAW.trim();
const CAL_ID = encodeURIComponent(GOOGLE_CALENDAR_ID);

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN || !GOOGLE_CALENDAR_ID) {
  throw new Error(
    "Missing one or more required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_CALENDAR_ID"
  );
}

// --- Time helpers (Denver) ---
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

// Returns a Date object representing local "today at 00:00" in the target timezone.
function startOfTodayInTZ(timeZone) {
  const localNow = new Date(new Date().toLocaleString("en-US", { timeZone }));
  localNow.setHours(0, 0, 0, 0);
  return localNow;
}

// Build a Date in the target timezone for YYYY-MM-DD at midnight.
// We do this by creating a local string in that TZ then parsing as Date.
function startOfDayFromYMDInTZ(ymd, timeZone) {
  const local = new Date(
    new Date(`${ymd}T00:00:00`).toLocaleString("en-US", { timeZone })
  );
  local.setHours(0, 0, 0, 0);
  return local;
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

// --- Categorization (optional labels for debugging) ---
function classify(titleRaw = "") {
  const t = titleRaw.toLowerCase();

  // Special Events
  if (t.includes("workshop") || t.includes("special") || t.includes("teacher training")) return "special-events";

  // Private
  if (t.includes("private")) return "private";

  // Other Classes bucket
  if (t.includes("trx") || t.includes("prenatal") || t.includes("community")) return "other-classes";

  // Core buckets
  if (t.includes("sculpt")) return "sculpt";
  if (t.includes("power")) return "power";
  if (t.includes("signature hot")) return "signature-hot";
  if (t.includes("restore") || t.includes("yin")) return "restore-yin";
  if (t.includes("slow flow")) return "slow-flow";
  if (t.includes("mobility")) return "mobility";

  // Flow variants
  if (t.includes("hot flow")) return "flow";
  if (t.includes("y6 flow") || t.includes("y6flow")) return "flow";
  if (t.includes(" flow")) return "flow";

  // Default
  return "other-classes";
}

// Stable ID so updates overwrite the same event instead of creating duplicates.
// We hash (location + class id) if present; fall back to (start+title).
function stableEventId(entry) {
  const base =
    entry?.id
      ? `${LOCATION}:${entry.id}`
      : `${LOCATION}:${entry.starts_at || ""}:${entry.title || ""}`;

  // Google Calendar eventId rules:
  // - 5-1024 chars
  // - allowed: lowercase letters, digits, underscores, hyphens
  const hash = crypto.createHash("sha1").update(base).digest("hex"); // 40 chars
  return `y6_${hash}`; // y6_ + 40 hex = safe
}

function buildSummary(entry) {
  const title = entry.title || "Yoga Class";
  const instructor = entry.instructor?.name || "TBA";
  const spots = typeof entry.free_spots === "number" ? `${entry.free_spots} spots` : "spots n/a";
  return `${title} — ${instructor} — ${spots}`;
}

function buildDescription(entry) {
  const lines = [];

  if (entry.subtitle) lines.push(`Notes: ${entry.subtitle}`);
  if (typeof entry.capacity === "number") lines.push(`Capacity: ${entry.capacity}`);
  if (entry.has_waitlist) lines.push(`Waitlist: ${entry.waitlist_size ?? "yes"}`);
  if (entry.booking_url) lines.push(`Book: ${entry.booking_url}`);

  const bucket = classify(entry.title || "");
  lines.push(`Category: ${bucket}`);

  return lines.join("\n");
}

async function fetchYogaSixEntries() {
  const { start_date, end_date } = getDateRange(30);
  const url = `https://members.yogasix.com/api/v2/locations/${LOCATION}/schedule_entries?start_date=${start_date}&end_date=${end_date}`;
  console.log("Fetching schedule from:", url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Schedule API failed: ${res.status}`);

  const data = await res.json();
  const entries = Array.isArray(data) ? data : (data.schedule_entries || []);
  console.log("Classes found:", entries.length);

  const todayStart = startOfTodayInTZ(STUDIO_TIMEZONE);

  // Keep only today+future (but include all of today)
  const filtered = entries.filter((e) => {
    const start = parseDate(e.starts_at);
    return start && start >= todayStart;
  });

  console.log("Classes kept (today+):", filtered.length);
  return filtered;
}

async function googleClient() {
  const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });

  // Ensure token can refresh
  await oauth2.getAccessToken();

  return google.calendar({ version: "v3", auth: oauth2 });
}

async function upsertEvents(calendar, entries) {
  // Build desired events map
  const desired = new Map();

  for (const e of entries) {
    const start = parseDate(e.starts_at);
    const end = parseDate(e.ends_at);
    if (!start || !end) continue;

    const id = stableEventId(e);

    desired.set(id, {
      id,
      summary: buildSummary(e),
      description: buildDescription(e),
      location: "YogaSix Edgewater",
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      source: { title: "YogaSix Edgewater", url: e.booking_url || undefined },
    });
  }

  console.log("Desired events:", desired.size);

  // Pull existing events in the same window (30 days from today) in Denver time
  const { start_date, end_date } = getDateRange(30);

  const timeMin = startOfDayFromYMDInTZ(start_date, STUDIO_TIMEZONE).toISOString();
  const timeMax = startOfDayFromYMDInTZ(end_date, STUDIO_TIMEZONE).toISOString();

  const existing = new Map();
  let pageToken = undefined;

  do {
    const resp = await calendar.events.list({
      calendarId: CAL_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      maxResults: 2500,
      pageToken,
    });

    for (const item of resp.data.items || []) {
      if (item.id?.startsWith("y6_")) existing.set(item.id, item);
    }

    pageToken = resp.data.nextPageToken || undefined;
  } while (pageToken);

  console.log("Existing y6_ events in window:", existing.size);

  // Upsert: patch if exists, insert if missing
  let created = 0;
  let updated = 0;

  for (const [id, ev] of desired.entries()) {
    if (existing.has(id)) {
      await calendar.events.patch({
        calendarId: CAL_ID,
        eventId: id,
        requestBody: ev,
      });
      updated++;
    } else {
      await calendar.events.insert({
        calendarId: CAL_ID,
        requestBody: ev,
      });
      created++;
    }
  }

  // Delete events that no longer exist upstream (within window)
  let deleted = 0;
  for (const [id] of existing.entries()) {
    if (!desired.has(id)) {
      await calendar.events.delete({
        calendarId: CAL_ID,
        eventId: id,
      });
      deleted++;
    }
  }

  console.log("Created:", created, "Updated:", updated, "Deleted:", deleted);
}

async function main() {
  // Debug prints that help diagnose hidden whitespace and calendar ID issues
  console.log("Calendar ID (raw JSON):", JSON.stringify(GOOGLE_CALENDAR_ID_RAW));
  console.log("Calendar ID (trimmed):", JSON.stringify(GOOGLE_CALENDAR_ID));
  console.log("Calendar ID length:", GOOGLE_CALENDAR_ID.length);

  const entries = await fetchYogaSixEntries();
  const calendar = await googleClient();

  // Sanity check: can we access the calendar?
  const cal = await calendar.calendars.get({ calendarId: CAL_ID });
  console.log("Target calendar summary:", cal.data.summary);

  await upsertEvents(calendar, entries);

  // Optional: write a small status file for debugging
  fs.mkdirSync("site", { recursive: true });
  fs.writeFileSync(
    "site/google-sync-status.json",
    JSON.stringify({ updatedAt: new Date().toISOString(), count: entries.length }, null, 2),
    "utf8"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
