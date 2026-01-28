import { chromium } from "playwright";
import ical from "ical-generator";
import fs from "node:fs";

const BOOK_URL = "https://members.yogasix.com/book/yogasix-edgewater";

function asDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

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
  await page.waitForTimeout(5000);
  await browser.close();

  let classes = [];
  for (const p of payloads) {
    if (Array.isArray(p?.data)) classes = p.data;
  }

  const cal = ical({ name: "YogaSix Edgewater" });

  for (const c of classes) {
    const start = asDate(c.startDateTime || c.start);
    if (!start) continue;

    const end = new Date(start.getTime() + 60 * 60 * 1000);

    cal.createEvent({
      start,
      end,
      summary: c.className || "YogaSix Class",
      location: "YogaSix Edgewater"
    });
  }

  fs.mkdirSync("site", { recursive: true });
  fs.writeFileSync("site/yogasix-edgewater.ics", cal.toString());
}

main();
