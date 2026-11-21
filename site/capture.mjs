// Captures the website screenshots from the real UI in headless Chromium (no window), talking to
// the real Rust engine through the dev-only bridge. Run via `site/capture.sh`.
//
// Env: SLONVIEW_UI_URL (default http://localhost:1450/), CHROME (headless shell binary).
// Needs the seeded `slonview_fixture` DB. Reads only.
import { homedir } from "node:os";
import puppeteer from "puppeteer-core";

const URL = process.env.SLONVIEW_UI_URL ?? "http://localhost:1450/";
const OUT = new globalThis.URL("./assets/", import.meta.url).pathname;
const CHROME =
  process.env.CHROME ??
  `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--window-size=1400,860"] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 860, deviceScaleFactor: 2 });
const until = (fn, ...args) => page.waitForFunction(fn, { timeout: 15000, polling: 50 }, ...args);
const clickText = (label, sel = "button") =>
  page.evaluate(
    (label, sel) => [...document.querySelectorAll(sel)].find((b) => b.innerText.trim() === label)?.click(),
    label,
    sel,
  );
const clickRel = (name, keep) =>
  page.evaluate(
    (nm, keep) => {
      const b = [...document.querySelectorAll('[role="group"] button[role="treeitem"]')].find((x) => x.querySelector("span")?.textContent === nm);
      b.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      if (keep) {
        b.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
        b.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
      }
    },
    name,
    keep,
  );
const gridReady = (from) =>
  until(
    (f) => (document.querySelector('footer span[title^="SELECT"]')?.title ?? "").includes(f) && !document.querySelector("footer .animate-spin") && !!document.querySelector(".dvn-scroller"),
    from,
  );

try {
  await page.goto(URL, { waitUntil: "networkidle0" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle0" });

  await page.click('[aria-label="New connection"]');
  await page.waitForSelector("#cd-url");
  await page.type("#cd-url", `postgres://${process.env.USER}@localhost:5432/slonview_fixture?sslmode=disable`);
  await clickText("Fill");
  await until(() => document.querySelector("#cd-db")?.value === "slonview_fixture");
  await page.$eval("#cd-name", (el) => el.select());
  await page.type("#cd-name", "local");
  await clickText("Save");
  await until(() => [...document.querySelectorAll('[role="option"]')].some((x) => x.innerText.includes("local")));
  await page.evaluate(() => {
    const li = [...document.querySelectorAll('[role="option"]')].find((x) => x.innerText.includes("local"));
    li.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  await until(() => document.querySelectorAll('[role="group"] button[role="treeitem"]').length > 5);

  // Table view: the million-row orders table, kept open.
  await clickRel("orders", true);
  await gridReady('FROM "public"."orders"');
  await sleep(400);
  for (const scheme of ["light", "dark"]) {
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await sleep(400);
    await page.screenshot({ path: `${OUT}/table-${scheme}.png` });
  }

  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.click('[aria-label="New SQL query"]');
  await page.waitForSelector(".cm-content");
  await page.click(".cm-content");
  const sql = "-- paid orders over 100, newest first\nSELECT o.id, c.name, o.amount, o.status, o.created_at\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nWHERE o.status = 'paid' AND o.amount > 100\nORDER BY o.created_at DESC\nLIMIT 50;";
  await page.evaluate((s) => document.execCommand("insertText", false, s), sql);
  await page.keyboard.press("Escape");
  await clickText("Run all");
  await until(() => /\b\d+ rows\b/.test(document.querySelector("main")?.innerText ?? document.body.innerText) && !document.querySelector(".animate-spin") && document.querySelectorAll(".dvn-scroller").length > 0);
  await sleep(500);
  for (const scheme of ["light", "dark"]) {
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await sleep(400);
    await page.screenshot({ path: `${OUT}/sql-${scheme}.png` });
  }
  console.log("captured table-{light,dark}.png and sql-{light,dark}.png");
} finally {
  await browser.close();
}
