import fs from "node:fs";
import crypto from "node:crypto";
import { google } from "googleapis";
import { classify } from "./lib/classify.js";
import { withRetry, sleepMs } from "./lib/google-retry.js";

// Small pause between sequential writes to stay under Google Calendar's per-user rate limit.
const WRITE_THROTTLE_MS = 100;

const LOCATION = "yogasix-edgewater";
const STUDIO_TIMEZONE = "America/Denver";
const FETCH_RETRIES = 3;
const FETCH_RETRY_DELAY_MS = 2000;
// Also delete stale tagged events up to this many days in the past, so classes that have
// already happened don't linger on the calendar forever.
const CLEANUP_LOOKBACK_DAYS = 2;

const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const GOOGLE_REFRESH_TOKEN = (process.env.GOOGLE_REFRESH_TOKEN || "").trim();

const GOOGLE_CALENDAR_ID_RAW = process.env.GOOGLE_CALENDAR_ID || "";
const CALENDAR_ID = GOOGLE_CALENDAR_ID_RAW.trim();

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN || !CALENDAR_ID) {
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

function startOfTodayInTZ(timeZone) {
  const localNow = new Date(new Date().toLocaleString("en-US", { timeZone }));
  localNow.setHours(0, 0, 0, 0);
  return localNow;
}

function startOfDayFromYMDInTZ(ymd, timeZone) {
  const local = new Date(new Date(`${ymd}T00:00:00`).toLocaleString("en-US", { timeZone }));
  local.setHours(0, 0, 0, 0);
  return local;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
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

// This is our stable key for matching events across runs.
// It can be ANY string; it does not have Google’s restrictive eventId rules.
function stableKey(entry) {
  const base = entry?.id
    ? `${LOCATION}:${entry.id}`
    : `${LOCATION}:${entry.starts_at || ""}:${entry.title || ""}`;

  // Keep it short-ish but stable
  return crypto.createHash("sha1").update(base).digest("hex"); // 40 chars
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
  lines.push(`Category: ${classify(entry.title || "")}`);
  return lines.join("\n");
}

async function fetchYogaSixEntries() {
  const { start_date, end_date } = getDateRange(30);
  const url = `https://members.yogasix.com/api/v2/locations/${LOCATION}/schedule_entries?start_date=${start_date}&end_date=${end_date}`;

  let entries;
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      console.log(`Fetching schedule from (attempt ${attempt}/${FETCH_RETRIES}):`, url);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Schedule API failed: ${res.status}`);

      const data = await res.json();
      entries = Array.isArray(data) ? data : (data.schedule_entries || []);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      console.error(`Fetch attempt ${attempt} failed:`, err.message);
      if (attempt < FETCH_RETRIES) await sleep(FETCH_RETRY_DELAY_MS * attempt);
    }
  }
  if (lastErr) throw lastErr;

  console.log("Classes found:", entries.length);

  const todayStart = startOfTodayInTZ(STUDIO_TIMEZONE);
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

  await oauth2.getAccessToken();
  return google.calendar({ version: "v3", auth: oauth2 });
}

function fingerprintEventFields(ev) {
  const payload = {
    summary: ev.summary || "",
    description: ev.description || "",
    location: ev.location || "",
    start: ev.start?.dateTime || "",
    end: ev.end?.dateTime || "",
  };
  return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

function eventFromEntry(entry) {
  const start = parseDate(entry.starts_at);
  const end = parseDate(entry.ends_at);
  if (!start || !end) return null;

  const key = stableKey(entry);

  const ev = {
    summary: buildSummary(entry),
    description: buildDescription(entry),
    location: "YogaSix Edgewater",
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    extendedProperties: {
      private: {
        yogasixKey: key,
        yogasixLocation: LOCATION,
        // yogasixFingerprint gets added below
      },
    },
  };

  // Compute fingerprint after fields are set
  ev.extendedProperties.private.yogasixFingerprint = fingerprintEventFields(ev);

  return ev;
}

async function listExisting(calendar, timeMin, timeMax) {
  const existingByKey = new Map();
  let pageToken = undefined;

  do {
    const resp = await withRetry(() =>
      calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin,
        timeMax,
        singleEvents: true,
        maxResults: 2500,
        pageToken,
      })
    );

    for (const item of resp.data.items || []) {
      const key = item.extendedProperties?.private?.yogasixKey;
      if (key) existingByKey.set(key, item);
    }

    pageToken = resp.data.nextPageToken || undefined;
  } while (pageToken);

  return existingByKey;
}

async function upsertEvents(calendar, entries) {
  const desiredByKey = new Map();

  for (const e of entries) {
    const ev = eventFromEntry(e);
    if (!ev) continue;
    const key = ev.extendedProperties.private.yogasixKey;
    desiredByKey.set(key, ev);
  }

  console.log("Desired events:", desiredByKey.size);

  const { start_date, end_date } = getDateRange(30);
  // Look back a couple of days (beyond "today") so recently-past events are pulled into
  // existingByKey and swept up by the orphan-delete pass below — desiredByKey only ever
  // contains today-forward entries, so anything in this lookback window that isn't desired
  // is safe to prune.
  const timeMin = addDays(
    startOfDayFromYMDInTZ(start_date, STUDIO_TIMEZONE),
    -CLEANUP_LOOKBACK_DAYS
  ).toISOString();
  const timeMax = startOfDayFromYMDInTZ(end_date, STUDIO_TIMEZONE).toISOString();

  const existingByKey = await listExisting(calendar, timeMin, timeMax);
  console.log("Existing events with yogasixKey in window:", existingByKey.size);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let deleted = 0;
  let failed = 0;

  for (const [key, desiredEvent] of desiredByKey.entries()) {
    const existing = existingByKey.get(key);

    try {
      if (existing?.id) {
        const existingFp = existing.extendedProperties?.private?.yogasixFingerprint || "";
        const desiredFp = desiredEvent.extendedProperties?.private?.yogasixFingerprint || "";

        if (existingFp === desiredFp) {
          skipped++;
          continue; // No change; skip patch
        }

        await withRetry(() =>
          calendar.events.patch({
            calendarId: CALENDAR_ID,
            eventId: existing.id,
            requestBody: desiredEvent,
          })
        );
        updated++;
      } else {
        await withRetry(() =>
          calendar.events.insert({
            calendarId: CALENDAR_ID,
            requestBody: desiredEvent,
          })
        );
        created++;
      }
    } catch (err) {
      // One failing call must not abort the whole run — otherwise the delete pass below never
      // runs and stale events accumulate instead of getting cleaned up.
      failed++;
      console.error(`Failed to upsert event (key=${key}):`, err.message);
    }
    await sleepMs(WRITE_THROTTLE_MS);
  }

  for (const [key, existing] of existingByKey.entries()) {
    if (!desiredByKey.has(key) && existing?.id) {
      try {
        await withRetry(() =>
          calendar.events.delete({
            calendarId: CALENDAR_ID,
            eventId: existing.id,
          })
        );
        deleted++;
      } catch (err) {
        failed++;
        console.error(`Failed to delete stale event (key=${key}, id=${existing.id}):`, err.message);
      }
      await sleepMs(WRITE_THROTTLE_MS);
    }
  }

  console.log(
    "Created:", created,
    "Updated:", updated,
    "Skipped:", skipped,
    "Deleted:", deleted,
    "Failed:", failed
  );
}

async function main() {
  const startedAt = Date.now();
  console.log("Calendar ID length:", CALENDAR_ID.length);

  const entries = await fetchYogaSixEntries();
  const calendar = await googleClient();

  // Sanity check: confirm calendar access
  const cal = await calendar.calendars.get({ calendarId: CALENDAR_ID });
  console.log("Target calendar summary:", cal.data.summary);

  await upsertEvents(calendar, entries);

  fs.mkdirSync("site", { recursive: true });
  fs.writeFileSync(
    "site/google-sync-status.json",
    JSON.stringify({ updatedAt: new Date().toISOString(), count: entries.length }, null, 2),
    "utf8"
  );

  console.log(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
