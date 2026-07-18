# YogaSix Edgewater → DakBoard Calendar

Generates a rolling 30-day class schedule for YogaSix Edgewater and publishes it two ways:

1. **Static `.ics` feeds** (one per category, plus one master feed) published to GitHub Pages,
   for DakBoard's calendar module to subscribe to directly — one module per feed, each with its
   own color.
2. **A live Google Calendar**, kept in sync via the Calendar API (create/update/delete), so class
   details and open-spot counts stay current in near real time.

Both read from YogaSix's public, unauthenticated schedule API — no login/cookies required.

## How it runs

Everything lives in [`.github/workflows/build-and-deploy.yml`](.github/workflows/build-and-deploy.yml),
with three scheduled jobs:

| Job | Cadence | What it does |
|---|---|---|
| `build_and_deploy_ics` | Daily, 5:00 AM Denver time | Full re-fetch of the schedule, rebuilds `cache/schedule.json` and every `.ics` file, deploys to Pages |
| `ics_spots_refresh` | Every 10 minutes | Reuses the day's cached schedule, refreshes only live `free_spots`/`capacity`/waitlist fields, regenerates the `.ics` files, deploys to Pages |
| `sync_google_calendar` | Every 15 minutes | Re-fetches the schedule live and upserts/deletes events on the Google Calendar |

All three can also be triggered manually via `workflow_dispatch` in the Actions tab.

The daily/10-min jobs share a `yogasix-pages-deploy` concurrency group (queued, not cancelled) so
they can't race each other's GitHub Pages deploy. The Google Calendar sync has its own
`yogasix-google-sync` group for the same reason — see "Duplication bug" below for why this
matters.

## Categories

`scraper/lib/classify.js` is the single source of truth for how a class title maps to a category,
shared by both the ICS generator and the Google Calendar sync so they never drift out of sync:

- `special-events` — workshops, "special", teacher trainings, TRX, community classes
- `private` — private sessions
- `sculpt`, `power`, `signature-hot`, `restore-yin`, `slow-flow`, `mobility` — specific class types
- `flow` — any other flow variant (hot flow, Y6 flow, etc.)
- `other-classes` — genuine catch-all (e.g. prenatal)

Each category gets its own `.ics` file in `site/` (see `CATEGORY_META` in `classify.js`), plus
`site/yogasix-edgewater.ics` as the combined master feed.

## Duplication bug (fixed)

Earlier versions of `sync-google-calendar.js`'s workflow ran with `cancel-in-progress: true`. If a
sync run took longer than its 15-minute schedule interval, the next scheduled trigger would kill
it mid-flight — after it had inserted/updated events but *before* it reached the pass that deletes
stale ones (that pass runs last in `upsertEvents()`). Repeated over time, this let duplicate/stale
class instances pile up on the calendar. The fix: `cancel-in-progress: false` so overlapping runs
queue instead of getting killed, plus per-event try/catch around every Calendar API call so one
failure can't abort the rest of the cleanup pass.

If your calendar already has leftover duplicates from before this fix, run the
**"Dedupe Google Calendar (one-off)"** workflow once from the Actions tab
(`scraper/dedupe-calendar.js`) — it finds every event sharing the same YogaSix class key, keeps
the most recently updated copy, and deletes the rest.

The sync also now only looks back 2 days when deciding what counts as "existing" on the calendar,
so classes older than that get cleaned up automatically instead of lingering forever.

## Required secrets

Set these as repository secrets (Settings → Secrets and variables → Actions):

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — OAuth client credentials from a Google Cloud
  project with the Calendar API enabled.
- `GOOGLE_REFRESH_TOKEN` — a refresh token for that OAuth client, generated once against the
  account/calendar you want to sync to.
- `GOOGLE_CALENDAR_ID` — the target calendar's ID (Calendar settings → "Integrate calendar").

`GITHUB_TOKEN` for the Pages deploy is provided automatically by Actions.

## Running locally

```
cd scraper
npm install
node scrape.js                 # MODE=full by default
MODE=spots node scrape.js      # spots-only refresh (needs an existing cache/schedule.json)
node sync-google-calendar.js   # needs the four GOOGLE_* env vars set locally
```
