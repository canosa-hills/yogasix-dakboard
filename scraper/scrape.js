import { chromium } from "playwright";

const PUBLIC_URL = "https://www.yogasix.com/location/edgewater";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  page.on("response", async (resp) => {
    const url = resp.url();
    const ct = resp.headers()["content-type"] || "";

    if (ct.includes("application/json")) {
      // Print only likely schedule/class endpoints
      if (/class|schedule|session|booking|calendar|event/i.test(url)) {
        console.log("JSON (schedule-ish):", url);
      }
    }
  });

  console.log("Loading public page...");
  await page.goto(PUBLIC_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(3000);

  // Click "View Schedule" if present (it is on the page) :contentReference[oaicite:1]{index=1}
  const viewSchedule = page.getByRole("link", { name: /view schedule/i });
  if (await viewSchedule.count()) {
    console.log('Clicking "View Schedule"...');
    await Promise.all([
      page.waitForLoadState("networkidle").catch(() => {}),
      viewSchedule.first().click()
    ]);
    await page.waitForTimeout(6000);
  } else {
    console.log('No "View Schedule" link found.');
  }

  // Scroll to trigger lazy-loaded schedule components
  await page.mouse.wheel(0, 2500);
  await page.waitForTimeout(6000);

  console.log("Done.");
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
