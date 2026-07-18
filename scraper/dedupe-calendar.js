import { google } from "googleapis";

// One-off cleanup for the Google Calendar duplication that built up while the sync job was
// getting cancelled mid-run (see README). Finds every event tagged with a yogasixKey, and for
// any key with more than one event, keeps the most-recently-updated copy and deletes the rest.
//
// Run manually via the "Dedupe Google Calendar (one-off)" GitHub Actions workflow — this is
// not part of the regular scheduled sync.

const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const GOOGLE_REFRESH_TOKEN = (process.env.GOOGLE_REFRESH_TOKEN || "").trim();
const CALENDAR_ID = (process.env.GOOGLE_CALENDAR_ID || "").trim();

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN || !CALENDAR_ID) {
  throw new Error(
    "Missing one or more required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_CALENDAR_ID"
  );
}

async function googleClient() {
  const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  await oauth2.getAccessToken();
  return google.calendar({ version: "v3", auth: oauth2 });
}

async function main() {
  const calendar = await googleClient();

  const byKey = new Map();
  let pageToken;
  let scanned = 0;

  do {
    const resp = await calendar.events.list({
      calendarId: CALENDAR_ID,
      singleEvents: true,
      maxResults: 2500,
      pageToken,
    });

    for (const item of resp.data.items || []) {
      const key = item.extendedProperties?.private?.yogasixKey;
      if (!key) continue;
      scanned++;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(item);
    }

    pageToken = resp.data.nextPageToken || undefined;
  } while (pageToken);

  console.log(`Scanned ${scanned} tagged events across ${byKey.size} distinct classes.`);

  let deleted = 0;
  let failed = 0;

  for (const [key, items] of byKey.entries()) {
    if (items.length <= 1) continue;

    // Keep the most recently updated copy, delete the rest.
    items.sort((a, b) => new Date(b.updated) - new Date(a.updated));
    const [, ...duplicates] = items;

    console.log(`Key ${key}: found ${items.length} copies, deleting ${duplicates.length}`);

    for (const dup of duplicates) {
      try {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: dup.id });
        deleted++;
      } catch (err) {
        failed++;
        console.error(`Failed to delete duplicate (key=${key}, id=${dup.id}):`, err.message);
      }
    }
  }

  console.log(`Done. Deleted ${deleted} duplicate events, ${failed} failures.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
