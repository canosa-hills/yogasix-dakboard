import { chromium } from "playwright";
import ical from "ical-generator";
import fs from "node:fs";

const BOOK_URL = "https://members.yogasix.com/book/yogasix-edgewater";

function asDate(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function findLikelyClasses(payloads) {
  // Scan payloads for arrays that look like class sessions
  const arrays = [];

  const walk = (obj) => {
    if (!obj) return;
    if (Array.isArray(obj)) {
      if (obj.length && typeof obj[0] === "object") arrays.push(obj);
      obj.forEach(walk);
      return;
    }
    if (typeof obj === "object") Object.values(obj).forEach(walk);
  };

  payloads.forEach(walk);

  // pick array with objects containing something like start time + class name
  const scored = arrays
    .map((arr) => {
      let score = 0;
      for (const item of arr) {
        const keys = Object.keys(item || {});
        if (keys.some((k) => /start/i.test(k))) score += 2;
        if (keys.some((k) => /end/i.test(k))) score += 1;
        if (keys.some((k) => /class|name|title/i.test(k))) score += 2;
        if (keys.some((k) => /instructor|teacher|staff/i.test(k))) score += 1;
      }
      return { arr, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.arr ?? [];
}

function toEvent(item) {
  const title = item.className || item.name || item.title || item.serviceName || "YogaSix Class";
  const instructor = item.instructorName || item.teacherName || item.staffName || item.instructor || "";

  const start =
    asDate(item.startDateTime || item.start_time || item.start || item.dateTime || item.datetime);

  const end =
    asDate(item.endDateTime || item.end_time || item.end) ||
    (start ? new Date(start.getTime() + 60 * 60 * 1000) : null);

  if (!start || !end) return null;

  return {
    summary: instructor ? `${title} — ${instructor}` : title,
    start,
    end,
    location: "YogaSix Edgewater"
  };
}

async function main() {
  const cookiesJson = process.env.YOGASIX_COOKIES_JSON;
  if (!cookiesJson) {
    throw new Error("Missing secret YOGASIX_COOKIES_JSON. Add it in GitHub repo Settings → Secrets.");
  }

  const cookies = JSON.parse(cookiesJson);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies(
    cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      expires: c.expires || -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: c.sameSite || "Lax"
    }))
  );

  const page = await context.newPage();

  const payloads = [];
  page.on("response", async (resp) => {
    const ct = resp.headers()["content-type"] || "";
    if (ct.includes("application/json")) {
      try {
        payloads.push(await resp.json());
      } catch {}
    }
  });

  await page.goto(BOOK_URL, { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForTimeout(8000);

  await browser.close();

  const classes = findLikelyClasses(payloads);
  const events = classes.map(toEvent).filter(Boolean);

  const cal = ical({ name: "YogaSix Edgewater — Upcoming Classes" });
  for (const e of events) {
    cal.createEvent({
      start: e.start,
      end: e.end,
      summary: e.summary,
      location: e.location
    });
  }

  fs.mkdirSync("site", { recursive: true });
  fs.writeFileSync("site/yogasix-edgewater.ics", cal.toString(), "utf8");

  console.log(`Events written: ${events.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
