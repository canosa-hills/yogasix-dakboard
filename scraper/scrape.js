import { chromium } from "playwright";

const BOOK_URL = "https://members.yogasix.com/book/yogasix-edgewater";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log("Loading booking page...");

  page.on("response", async (resp) => {
    const url = resp.url();
    const ct = resp.headers()["content-type"] || "";

    if (ct.includes("application/json")) {
      console.log("JSON FOUND:", url);
    }
  });

  await page.goto(BOOK_URL, { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForTimeout(8000);

  console.log("Done.");
  await browser.close();
}

main();
