// Full-UI E2E: the real React frontend in headless Chromium, talking to the real Rust engine
// through the dev-only bridge. Run `tests/e2e/run.sh` (starts both servers) or, with them
// already up, `node tests/e2e/ui.e2e.mjs`.
//
// Env: SLONVIEW_UI_URL (default http://localhost:1450/), CHROME (headless shell binary),
//      SLONVIEW_E2E_SHOTS (screenshot dir, default /tmp/slonview-e2e).
// Needs the seeded fixture DB and an empty profile dir in the bridge. Creates a profile +
// credential-store entry and deletes both at the end; writes only to scratch_insert_target.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import puppeteer from "puppeteer-core";

const URL = process.env.SLONVIEW_UI_URL ?? "http://localhost:1450/";
const BRIDGE = "http://127.0.0.1:1499/invoke/";
const SHOTS = process.env.SLONVIEW_E2E_SHOTS ?? "/tmp/slonview-e2e";
const PREVIEW_SHOTS = process.env.SLONVIEW_PREVIEW_SHOTS ?? "/tmp/slonview-preview";
const CHROME =
  process.env.CHROME ??
  `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const PASSWORD = "e2e-ui-s3cret";
mkdirSync(SHOTS, { recursive: true });

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psql = (sql, db = "slonview_fixture") =>
  execFileSync("psql", ["-h", process.env.PGHOST ?? "/tmp", "-d", db, "-Atq", "-c", sql], { encoding: "utf8" }).trim();
const bridge = async (cmd, args = {}) => {
  const res = await fetch(BRIDGE + cmd, { method: "POST", body: JSON.stringify(args) });
  return res.json();
};

async function check(id, fn) {
  const t0 = Date.now();
  try {
    const evidence = await fn();
    results.push({ id, status: "PASS", evidence, ms: Date.now() - t0 });
    console.log(`PASS ${id}  ${evidence ?? ""}`);
  } catch (e) {
    results.push({ id, status: "FAIL", evidence: String(e?.stack ?? e), ms: Date.now() - t0 });
    console.log(`FAIL ${id}  ${e?.stack ?? e}`);
    await page.screenshot({ path: `${SHOTS}/FAIL-${id}.png` }).catch(() => {});
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--window-size=1400,900"] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const consoleErrors = [];
page.on("console", (m) => {
  // Expected AppErrors travel as HTTP 400 from the bridge; Chromium logs each as a failed
  // resource load. Tauri IPC has no such log, so those are not app errors.
  if (m.type() === "error" && !(m.location()?.url ?? "").startsWith(BRIDGE)) consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(String(e)));

// ---- helpers over the real DOM -------------------------------------------------------
const until = async (fn, timeout = 15000, ...args) => page.waitForFunction(fn, { timeout, polling: 50 }, ...args);
const text = () => page.evaluate(() => document.body.innerText);
const clickText = async (label, sel = "button") => {
  const ok = await page.evaluate(
    (label, sel) => {
      const el = [...document.querySelectorAll(sel)].find((b) => b.innerText.trim() === label);
      el?.click();
      return !!el;
    },
    label,
    sel,
  );
  assert(ok, `no ${sel} "${label}"`);
};
/** Clicks a relation in the tree like a mouse does: `detail` 1 (preview), or 1, 2 + dblclick when `keep`. */
const clickRel = async (name, keep = false) => {
  const ok = await page.evaluate(
    (nm, keep) => {
      const b = [...document.querySelectorAll('[role="group"] button[role="treeitem"]')].find((x) => x.querySelector("span")?.textContent === nm);
      if (!b) return false;
      b.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      if (keep) {
        b.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
        b.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
      }
      return true;
    },
    name,
    keep,
  );
  assert(ok, `relation ${name} not in tree`);
};
/** Tab strip as "title" / "title*" (preview, rendered italic). */
const tabStrip = () =>
  page.$$eval('[role="tab"]', (tabs) =>
    tabs.map((t) => {
      const italic = getComputedStyle(t.querySelector("span.truncate")).fontStyle === "italic";
      if (italic !== t.hasAttribute("data-preview")) throw new Error(`italic/preview mismatch on ${t.innerText}`);
      return `${t.innerText.trim()}${italic ? "*" : ""}`;
    }),
  );
/** Opens a relation as a preview tab, or a kept (pinned) one with `{ keep: true }`. */
const openRel = async (name, schema = "public", { keep = false } = {}) => {
  await clickRel(name, keep);
  const title = schema === "public" ? name : `${schema}.${name}`;
  await until((t) => document.querySelector('[role="tab"][aria-selected="true"]')?.innerText.trim() === t, 10000, title);
  // The footer SQL names this relation and its grid is mounted.
  const fromClause = `FROM "${schema.replace(/"/g, '""')}"."${name.replace(/"/g, '""')}"`;
  await until(
    (f) =>
      (document.querySelector('footer span[title^="SELECT"]')?.title ?? "").includes(f) &&
      !document.querySelector("footer .animate-spin") &&
      !!document.querySelector(".dvn-scroller"),
    15000,
    fromClause,
  );
};
const activateTab = async (title) => {
  await page.evaluate((t) => {
    const el = [...document.querySelectorAll('[role="tab"]')].find((x) => x.innerText.trim() === t);
    el?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  }, title);
  await sleep(300);
};
const footerSql = () => page.evaluate(() => document.querySelector('footer span[title^="SELECT"]')?.title ?? "");
const loadedLabel = () => page.evaluate(() => document.querySelector("footer span")?.innerText ?? "");
const gridTop = () => page.evaluate(() => document.querySelector(".dvn-scroller").getBoundingClientRect().y);
const ROW = 24;
const HEADER = 34;
const MARKER_X = 286;
const selectRows = async (from, to) => {
  const y = await gridTop();
  await page.mouse.click(MARKER_X, y + HEADER + ROW * from + 12);
  await page.keyboard.down("Shift");
  await page.mouse.click(MARKER_X, y + HEADER + ROW * to + 12);
  await page.keyboard.up("Shift");
};
/** Viewport point of row `row` in the column named `columnName`, with the cell inspector left open.
 *  Glide draws on a canvas, so the x is found by hit-testing: click along the row until the inspector
 *  header names the column. The inspector narrows the grid, so callers click while it stays open. */
const cellPoint = async (columnName, row) => {
  const top = await gridTop();
  const y = top + HEADER + ROW * row + 12;
  const inspected = () => page.evaluate(() => document.querySelector('aside[aria-label="Cell inspector"] .font-semibold')?.textContent ?? null);
  const box = await page.evaluate(() => document.querySelector(".dvn-scroller").getBoundingClientRect().toJSON());
  await page.mouse.click(box.x + 60, y);
  if ((await inspected()) === null) await page.click('[aria-label="Toggle cell inspector"]');
  await until(() => !!document.querySelector('aside[aria-label="Cell inspector"]'), 5000);
  const narrowed = await page.evaluate(() => document.querySelector(".dvn-scroller").getBoundingClientRect().toJSON());
  for (let x = narrowed.x + 60; x < narrowed.x + narrowed.width; x += 12) {
    await page.mouse.click(x, y);
    if ((await inspected()) === columnName) return { x, y };
  }
  throw new Error(`could not locate ${columnName} row ${row}`);
};
const setSql = async (sql) => {
  await page.click(".cm-content");
  await page.keyboard.down("Meta");
  await page.keyboard.press("a");
  await page.keyboard.up("Meta");
  await page.keyboard.press("Backspace");
  // insertText avoids autocomplete/auto-close brackets mangling the statement.
  await page.evaluate((s) => document.execCommand("insertText", false, s), sql);
  await page.keyboard.press("Escape");
};
const runAll = async () => clickText("Run all");
const filterBarOpen = () => page.evaluate(() => document.querySelector('button[title="Toggle filters"]')?.getAttribute("aria-pressed") === "true");
const ensureFilterBar = async () => {
  if (!(await filterBarOpen())) await page.click('button[title="Toggle filters"]');
};

try {
  await page.goto(URL, { waitUntil: "networkidle0" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle0" });
  let connId = null;

  await check("E2E-01 add connection by URL", async () => {
    await page.click('[aria-label="New connection"]');
    await page.waitForSelector("#cd-url");
    await page.type("#cd-url", `postgres://${process.env.USER}:${PASSWORD}@localhost:5432/slonview_fixture?sslmode=disable`);
    await clickText("Fill");
    await until(() => document.querySelector("#cd-db")?.value === "slonview_fixture");
    await page.$eval("#cd-name", (el) => el.select());
    await page.type("#cd-name", "E2E Fixture");
    await clickText("Test");
    await until(() => /PostgreSQL/.test(document.querySelector('[aria-live="polite"]')?.innerText ?? ""));
    await page.screenshot({ path: `${SHOTS}/01-dialog-test-ok.png` });
    await clickText("Save");
    await until(() => document.body.innerText.includes("E2E Fixture"));
    const profiles = await bridge("list_profiles");
    connId = profiles.find((p) => p.name === "E2E Fixture").id;
    const toml = readFileSync(`${process.env.SLONVIEW_E2E_DIR ?? "/tmp/slonview-e2e-data"}/connections.toml`, "utf8");
    assert(!toml.includes(PASSWORD), "password found in connections.toml");
    const kc = await bridge("e2e_keychain_get", { id: connId });
    eq(kc, PASSWORD, "keychain password");
    return `profile ${connId}; credential store has password; TOML has none`;
  });

  await check("E2E-02 wrong password / host down", async () => {
    const out = [];
    for (const [url, kind] of [
      [`postgres://nosuchrole@localhost:5432/slonview_fixture?sslmode=disable`, /role "nosuchrole" does not exist/],
      [`postgres://${process.env.USER}@localhost:5999/slonview_fixture?sslmode=disable`, /Connection refused/],
      [`postgres://${process.env.USER}@no-such-host.invalid:5432/slonview_fixture`, /lookup address/],
    ]) {
      await page.click('[aria-label="New connection"]');
      await page.waitForSelector("#cd-url");
      await page.type("#cd-url", url);
      await clickText("Fill");
      await sleep(200);
      await clickText("Test");
      await until(() => {
        const t = document.querySelector('[aria-live="polite"]')?.innerText.trim() ?? "";
        return t && !t.startsWith("Connecting");
      }, 30000);
      const msg = await page.$eval('[aria-live="polite"]', (e) => e.innerText);
      assert(kind.test(msg), `unexpected message ${msg}`);
      const t0 = Date.now();
      await page.evaluate(() => 1);
      assert(Date.now() - t0 < 200, "UI not responsive");
      out.push(msg.slice(0, 50));
      await clickText("Cancel");
    }
    await page.screenshot({ path: `${SHOTS}/02-errors.png` });
    const auth = await bridge("test_connection", {
      profile: { ...(await bridge("list_profiles"))[0], user: "nosuchrole" },
      password: null,
    });
    eq(auth.kind, "auth", "typed auth error");
    return out.join(" | ") + " | kinds: auth/connect";
  });

  await check("A connect to fixture", async () => {
    await page.evaluate(() => {
      const li = [...document.querySelectorAll('[role="option"]')].find((x) => x.innerText.includes("E2E Fixture"));
      li.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await until(() => document.querySelectorAll('[role="group"] button[role="treeitem"]').length > 5);
    return "schema tree loaded";
  });

  await check("Preview tabs: click previews, double-click and filters keep", async () => {
    eq((await tabStrip()).length, 0, "no tabs before the check");
    await openRel("orders");
    await openRel("customers");
    eq(JSON.stringify(await tabStrip()), JSON.stringify(["customers*"]), "second click replaced the preview");
    const label = await page.$eval('[role="tab"]', (t) => `${t.getAttribute("aria-label")} | ${t.title}`);
    assert(label.includes("Preview, double-click to keep open"), `preview hint missing: ${label}`);
    await clickRel("customers", true);
    await until(() => !document.querySelector('[role="tab"][data-preview]'), 5000);
    eq(JSON.stringify(await tabStrip()), JSON.stringify(["customers"]), "double-click kept customers");
    await openRel("no_pk");
    eq(JSON.stringify(await tabStrip()), JSON.stringify(["customers", "no_pk*"]), "new preview after the kept tab");
    mkdirSync(PREVIEW_SHOTS, { recursive: true });
    for (const scheme of ["light", "dark"]) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await sleep(300);
      await page.screenshot({ path: `${PREVIEW_SHOTS}/tabs-${scheme}.png` });
      const box = await (await page.$('[role="tablist"]')).boundingBox();
      await page.screenshot({ path: `${PREVIEW_SHOTS}/tabs-strip-${scheme}.png`, clip: { x: box.x, y: box.y, width: 520, height: box.height } });
    }
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await ensureFilterBar();
    await page.type('input[aria-label="Raw WHERE expression"]', "a > 1");
    await page.keyboard.press("Enter");
    await until(() => !document.querySelector('[role="tab"][data-preview]'), 5000);
    eq(JSON.stringify(await tabStrip()), JSON.stringify(["customers", "no_pk"]), "filtering kept no_pk");
    // Back to no tabs so the filtered no_pk does not leak into later checks.
    for (let i = 0; i < 2; i++) {
      await page.keyboard.down("Meta");
      await page.keyboard.press("w");
      await page.keyboard.up("Meta");
    }
    await until(() => document.querySelectorAll('[role="tab"]').length === 0, 5000);
    return `orders then customers: [customers*]; double-click: [customers]; no_pk: [customers, no_pk*]; filter: [customers, no_pk]; shots in ${PREVIEW_SHOTS}`;
  });

  await check("V2-01 row estimate in the footer before any count", async () => {
    await openRel("orders", "public", { keep: true });
    const label = await loadedLabel();
    assert(/^500\+ rows loaded of ~1(\.0)?M$/.test(label), `footer: ${label}`);
    return `unfiltered orders footer: "${label}"`;
  });

  await check("V2-02 foreign key: menu and Cmd-click open the referenced row", async () => {
    await activateTab("orders");
    const want = psql("SELECT customer_id FROM orders ORDER BY id LIMIT 1");
    const p = await cellPoint("customer_id", 0);
    await page.mouse.click(p.x, p.y, { button: "right" });
    await until(() => [...document.querySelectorAll('[role="menuitem"]')].some((m) => m.innerText.startsWith("Open referenced row")), 5000);
    const label = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.innerText.startsWith("Open referenced row")).innerText);
    assert(label.includes("customers"), `menu item: ${label}`);
    await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.innerText.startsWith("Open referenced row")).click());
    await until(() => document.querySelector('[role="tab"][aria-selected="true"]')?.innerText.trim() === "customers", 10000);
    await until((w) => (document.querySelector('footer span[title^="SELECT"]')?.title ?? "").includes(`"id" = '${w}'`), 10000, want);
    await until(() => document.querySelector("footer span")?.innerText === "1 row loaded", 10000);
    await page.screenshot({ path: `${SHOTS}/v2-02-fk-followed.png` });

    // Cmd-click the same cell: the tab already showing that row is reused.
    await activateTab("orders");
    const before = (await tabStrip()).length;
    await page.keyboard.down("Meta");
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up("Meta");
    await until(() => document.querySelector('[role="tab"][aria-selected="true"]')?.innerText.trim() === "customers", 10000);
    eq((await tabStrip()).length, before, "tab count after Cmd-click");

    // Composite foreign key: not offered. Single-column key into a quoted schema: offered.
    await openRel("fk_links", "public", { keep: true });
    const menuFor = async (column) => {
      const c = await cellPoint(column, 0);
      await page.mouse.click(c.x, c.y, { button: "right" });
      await until(() => document.querySelectorAll('[role="menuitem"]').length > 0, 5000);
      const items = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.innerText));
      await page.keyboard.press("Escape");
      return items;
    };
    const tenant = await menuFor("tenant");
    assert(!tenant.some((t) => t.startsWith("Open referenced row")), `composite FK offered: ${tenant.join(" | ")}`);
    const weird = await menuFor("weird_id");
    assert(weird.some((t) => t.includes('Sales Data.Weird "Name" Table')), `quoted target: ${weird.join(" | ")}`);
    return `orders.customer_id ${want} -> customers (id = ${want}, 1 row); Cmd-click reused the tab (${before} tabs); fk_links.tenant not offered; weird_id -> "Sales Data"`;
  });

  await check("E2E-03 scroll orders to 200k", async () => {
    await openRel("orders");
    await page.evaluate(() => {
      window.__frames = [];
      let last = performance.now();
      const loop = (t) => {
        window.__frames.push(t - last);
        last = t;
        if (!window.__stop) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    let rows = 0;
    const t0 = Date.now();
    while (rows < 200000) {
      assert(Date.now() - t0 < 300000, "did not reach 200k rows in 5 min");
      rows = await page.evaluate(() => {
        const s = document.querySelector(".dvn-scroller");
        s.scrollTop = s.scrollHeight;
        const m = document.querySelector("footer span")?.innerText.match(/([\d,]+)/);
        return m ? Number(m[1].replace(/,/g, "")) : 0;
      });
      await sleep(50);
    }
    const s = await page.evaluate(() => {
      window.__stop = true;
      const f = window.__frames.slice(5).sort((a, b) => a - b);
      return { p99: f[Math.floor(f.length * 0.99)], max: f[f.length - 1], heap: Math.round(performance.memory.usedJSHeapSize / 1048576) };
    });
    const t1 = Date.now();
    await page.evaluate(() => 1);
    assert(Date.now() - t1 < 200, "UI not responsive after scroll");
    assert(s.max < 250, `long frame ${s.max} ms`);
    assert(s.heap < 600, `heap ${s.heap} MB`);
    await page.screenshot({ path: `${SHOTS}/03-orders-200k.png` });
    return `${rows.toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(1)} s; frame p99 ${s.p99.toFixed(1)} ms, max ${s.max.toFixed(1)} ms; JS heap ${s.heap} MB`;
  });

  await check("E2E-04 all_types: types render, NULL vs 'NULL'", async () => {
    await openRel("all_types");
    const y = await gridTop();
    // Row 2 c_text is SQL NULL; row 3 is the text 'NULL'. c_text is column index 3.
    // Each inspection starts with the inspector closed so the grid width (and so the click
    // target) is the same, clicks the first data column, then moves right by keyboard.
    const inspect = async (row) => {
      if (await page.$('[aria-label="Close inspector"]')) await page.click('[aria-label="Close inspector"]');
      await until(() => !document.querySelector('[aria-label="Cell inspector"]'));
      await page.evaluate(() => (document.querySelector(".dvn-scroller").scrollLeft = 0));
      await sleep(150);
      await page.mouse.click(330, y + HEADER + ROW * row + 12);
      await sleep(100);
      for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await until(() => document.querySelector('[aria-label="Cell inspector"]')?.innerText.startsWith("c_text"));
      await sleep(300);
      return page.$eval('[aria-label="Cell inspector"]', (e) => e.innerText);
    };
    const sqlNull = await inspect(1);
    const textNull = await inspect(2);
    assert(/c_text[\s\S]*NULL/.test(sqlNull) && !/chars/.test(sqlNull), `SQL NULL inspector: ${sqlNull}`);
    assert(/4 chars[\s\S]*NULL/.test(textNull), `'NULL' inspector: ${textNull}`);
    const long = await inspect(3);
    assert(/10,000 chars/.test(long), "huge cell not fetched in full");
    await page.screenshot({ path: `${SHOTS}/04-all-types-inspector.png` });
    await page.click('[aria-label="Close inspector"]');
    const page1 = await bridge("fetch_page", {
      requestId: "t",
      req: { connId, schema: "public", table: "all_types", filters: [], rawWhere: null, sort: [], cursor: null, limit: 500 },
    });
    const psqlRows = psql("select count(*) from all_types");
    eq(String(page1.rows.length), psqlRows, "row count");
    return "SQL NULL shows italic NULL without length; text 'NULL' shows '4 chars'; 10,000-char cell fetched in full";
  });

  await check("E2E-05 quoted schema/table names", async () => {
    await openRel('Weird "Name" Table', "Sales Data");
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        const s = document.querySelector(".dvn-scroller");
        s.scrollTop = s.scrollHeight;
      });
      await sleep(250);
    }
    eq(await loadedLabel(), "250 rows loaded", "all pages");
    const y = await gridTop();
    await page.mouse.click(540, y + 17);
    await sleep(500);
    await page.mouse.click(540, y + 17);
    await until(() => /"Column With Space" DESC/.test(document.querySelector('footer span[title^="SELECT"]')?.title ?? ""));
    await page.screenshot({ path: `${SHOTS}/05-weird-sorted.png` });
    return (await footerSql()).replace(/^SELECT .* FROM/, "FROM");
  });

  await check("E2E-06 filter status='paid' + sort created_at desc matches psql", async () => {
    await openRel("orders");
    await ensureFilterBar();
    await clickText("Filter");
    const fid = (await page.$eval('select[id^="fc-"]', (e) => e.id)).slice(3);
    await page.select(`#fc-${fid}`, "status");
    await page.type('input[aria-label="Value"]', "paid");
    await page.keyboard.press("Enter");
    await until(() => /WHERE "status" = 'paid'/.test(document.querySelector('footer span[title^="SELECT"]')?.title ?? ""));
    const y = await gridTop();
    await page.mouse.click(1300, y + 17);
    await sleep(500);
    await page.mouse.click(1300, y + 17);
    await until(() => /"created_at" DESC/.test(document.querySelector('footer span[title^="SELECT"]')?.title ?? ""));
    await sleep(300);
    await selectRows(0, 19);
    await page.keyboard.down("Meta");
    await page.keyboard.press("c");
    await page.keyboard.up("Meta");
    await sleep(200);
    const clip = await page.evaluate(() => window.__clipboard);
    const expected = psql(
      "select string_agg(concat_ws(E'\\t', id, customer_id, status, amount, coalesce(note,'NULL'), created_at), E'\\n') from (select * from orders where status='paid' order by created_at desc, id limit 20) s",
    );
    eq(clip.split("\n").slice(1).join("\n"), expected, "first 20 rows");
    await clickText("Count rows");
    await until(() => /[\d,]+ rows$/.test(document.querySelector('main [aria-live="polite"]')?.innerText.trim() ?? ""));
    const n = await page.$eval('main [aria-live="polite"]', (e) => e.innerText.trim());
    eq(n, `${Number(psql("select count(*) from orders where status='paid'")).toLocaleString("en-US")} rows`, "count");
    await page.screenshot({ path: `${SHOTS}/06-filter-sort.png` });
    return `first 20 rows identical to psql; count ${n}`;
  });

  await check("E2E-09 copy 10 rows as INSERT, run in scratch DB", async () => {
    await selectRows(0, 9);
    const y = await gridTop();
    await page.mouse.click(800, y + HEADER + ROW * 3 + 12, { button: "right" });
    await sleep(200);
    await clickText("Copy as INSERT", '[role="menuitem"], button');
    await sleep(200);
    const sql = await page.evaluate(() => window.__clipboard);
    eq(sql.split("\n").length, 10, "10 INSERT lines");
    writeFileSync(`${SHOTS}/09-insert.sql`, sql);
    execFileSync("dropdb", ["-h", "/tmp", "--if-exists", "slonview_e2e_scratch"]);
    execFileSync("createdb", ["-h", "/tmp", "slonview_e2e_scratch"]);
    const labels = psql("select string_agg(quote_literal(enumlabel), ',' order by enumsortorder) from pg_enum where enumtypid = 'order_status'::regtype");
    psql(`CREATE TYPE order_status AS ENUM (${labels})`, "slonview_e2e_scratch");
    psql(
      "CREATE TABLE public.orders (id bigint primary key, customer_id bigint not null, status order_status not null, amount numeric(12,2) not null, note text, created_at timestamptz not null)",
      "slonview_e2e_scratch",
    );
    execFileSync("psql", ["-h", "/tmp", "-d", "slonview_e2e_scratch", "-v", "ON_ERROR_STOP=1", "-q", "-f", `${SHOTS}/09-insert.sql`]);
    const copied = psql("select string_agg(t::text, '|' order by id) from orders t", "slonview_e2e_scratch");
    const source = psql(
      "select string_agg(t::text, '|' order by id) from orders t where id in (select id from orders where status='paid' order by created_at desc, id limit 10)",
    );
    eq(copied, source, "inserted rows");
    // Filters off again for the next checks.
    await page.click('[aria-label="Remove filter"]');
    await sleep(500);
    return "10 INSERTs succeeded in slonview_e2e_scratch; rows identical to source";
  });

  await check("A filter values with quotes/injection; NULL vs 'NULL' filters", async () => {
    await openRel("all_types");
    await ensureFilterBar();
    await clickText("Filter");
    const fid = (await page.$eval('select[id^="fc-"]', (e) => e.id)).slice(3);
    await page.select(`#fc-${fid}`, "c_text");
    const cases = [
      ["=", "O'Brien; DROP TABLE orders; --", "1 row loaded"],
      ["ILIKE", "%'); select 1; --%", "0 rows loaded"],
      ["=", "NULL", "1 row loaded"],
      ["IS NULL", null, "1 row loaded"],
      ["=", "back\\slash", "0 rows loaded"],
      ["IN", "hello, NULL", "2 rows loaded"],
    ];
    const out = [];
    for (const [op, v, expectLabel] of cases) {
      await page.select(`#fo-${fid}`, op);
      if (v !== null) {
        await page.$eval('input[aria-label="Value"]', (e) => e.select());
        await page.type('input[aria-label="Value"]', v);
      }
      await clickText("Apply");
      await sleep(700);
      eq(await loadedLabel(), expectLabel, `${op} ${v}`);
      out.push(`${op} ${JSON.stringify(v)} -> ${expectLabel}`);
    }
    eq(psql("select count(*) from orders"), "1000000", "orders intact");
    await page.click('[aria-label="Remove filter"]');
    await sleep(500);
    return out.join("; ");
  });

  await check("A raw WHERE syntax error shows Postgres error at user-text position", async () => {
    await page.type('input[aria-label="Raw WHERE expression"]', "c_int >> AND");
    await page.keyboard.press("Enter");
    await until(() => !!document.querySelector('main [role="alert"]'));
    const msg = await page.$eval('main [role="alert"]', (e) => e.innerText);
    assert(/SQLSTATE 42601/.test(msg) && /at position 10/.test(msg) && /syntax error at or near "AND"/.test(msg), msg);
    await page.screenshot({ path: `${SHOTS}/A-raw-where-error.png` });
    await page.$eval('input[aria-label="Raw WHERE expression"]', (e) => e.select());
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await sleep(500);
    return msg.replace(/\n/g, " ");
  });

  await check("A cancel during count and during load", async () => {
    await openRel("orders");
    await ensureFilterBar();
    await page.type('input[aria-label="Raw WHERE expression"]', "pg_sleep(0.00001) IS NOT NULL");
    await page.keyboard.press("Enter");
    await until(() => !document.querySelector("footer .animate-spin"), 30000);
    await clickText("Count rows");
    await until(() => document.body.innerText.includes("counting…"));
    const t0 = Date.now();
    await page.keyboard.down("Meta");
    await page.keyboard.press("r");
    await page.keyboard.up("Meta");
    await until(() => !document.body.innerText.includes("counting…"), 5000);
    const countStop = Date.now() - t0;
    await page.$eval('input[aria-label="Raw WHERE expression"]', (e) => e.select());
    await page.type('input[aria-label="Raw WHERE expression"]', "pg_sleep(0.001) IS NOT NULL");
    await page.keyboard.press("Enter");
    await until(() => [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Cancel"));
    await clickText("Cancel");
    await until(() => document.body.innerText.includes("Load cancelled."), 3000);
    // Only Slonview's own sessions count; other tools (cargo tests, psql) may share the DB.
    // Poll briefly: a cancelled backend can take a moment to report idle.
    let active = "";
    for (let i = 0; i < 20; i++) {
      active = psql("select count(*) from pg_stat_activity where datname='slonview_fixture' and application_name='slonview' and state='active'");
      if (active === "0") break;
      await sleep(150);
    }
    eq(active, "0", "server-side queries still active");
    await page.$eval('input[aria-label="Raw WHERE expression"]', (e) => e.select());
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await sleep(800);
    return `count cancelled in ${countStop} ms; page load cancelled; 0 active backends`;
  });

  await check("E2E-10 rapidly click 5 tables", async () => {
    const names = ["customers", "events", "no_pk", "composite_pk", "order_totals"];
    const before = await tabStrip();
    await page.evaluate((names) => {
      const btns = [...document.querySelectorAll('[role="group"] button[role="treeitem"]')];
      for (const nm of names) btns.find((b) => b.querySelector("span")?.textContent === nm).dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    }, names);
    await sleep(1500);
    const active = await page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.innerText.trim());
    eq(active, "order_totals", "active tab");
    assert((await footerSql()).includes('"public"."order_totals"'), "grid shows another table");
    const after = await tabStrip();
    eq(after.filter((t) => t.endsWith("*")).join(), "order_totals*", "exactly one preview tab");
    eq(after.length, before.filter((t) => !t.endsWith("*")).length + 1, "kept tabs plus one preview");
    const cols = await bridge("describe_table", { connId, schema: "public", table: "order_totals" });
    await page.screenshot({ path: `${SHOTS}/10-rapid.png` });
    return `active order_totals, the only preview tab (${after.length} tabs); grid SQL targets order_totals (${cols.columns.length} cols)`;
  });

  await check("A Cmd+T / Cmd+W shortcuts", async () => {
    const n0 = await page.$$eval('[role="tab"]', (t) => t.length);
    await page.keyboard.down("Meta");
    await page.keyboard.press("t");
    await page.keyboard.up("Meta");
    await sleep(300);
    const n1 = await page.$$eval('[role="tab"]', (t) => t.length);
    eq(n1, n0 + 1, "Cmd+T");
    eq(await page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.innerText.trim()), "Query 1", "new SQL tab active");
    await page.keyboard.down("Meta");
    await page.keyboard.press("w");
    await page.keyboard.up("Meta");
    await sleep(300);
    eq(await page.$$eval('[role="tab"]', (t) => t.length), n0, "Cmd+W");
    return `${n0} -> ${n1} -> ${n0} tabs`;
  });

  await check("E2E-07 DELETE FROM orders with read-only on", async () => {
    await page.keyboard.down("Meta");
    await page.keyboard.press("t");
    await page.keyboard.up("Meta");
    await page.waitForSelector(".cm-content");
    await setSql("DELETE FROM orders");
    await runAll();
    await until(() => !!document.querySelector('[role="alert"]'));
    const msg = await page.$eval('[role="alert"]', (e) => e.innerText);
    assert(/read-only transaction/.test(msg) && /25006/.test(msg), msg);
    eq(psql("select count(*) from orders"), "1000000", "orders intact");
    await page.screenshot({ path: `${SHOTS}/07-readonly.png` });
    return msg.replace(/\n+/g, " ");
  });

  await check("RO-01 explicit transaction escape rejected", async () => {
    await setSql("BEGIN READ WRITE; DELETE FROM orders; COMMIT;");
    await runAll();
    await until(() => document.querySelector('[role="alert"]')?.innerText.includes("Read-only mode:"));
    const msg = await page.$eval('[role="alert"]', (e) => e.innerText);
    assert(msg.includes("BEGIN") && msg.includes("Allow writes"), msg);
    eq(psql("select count(*) from orders"), "1000000", "orders intact after BEGIN bypass");
    return msg.replace(/\n+/g, " ");
  });

  await check("RO-02 GUC escape rolled back and next run stays read-only", async () => {
    await setSql("SET default_transaction_read_only = off; DELETE FROM orders;");
    await runAll();
    await until(() => document.querySelector('[role="alert"]')?.innerText.includes("25006"));
    eq(psql("select count(*) from orders"), "1000000", "orders intact after SET bypass");
    await setSql("DELETE FROM orders;");
    await runAll();
    await until(() => document.querySelector('[role="alert"]')?.innerText.includes("25006"));
    eq(psql("select count(*) from orders"), "1000000", "orders intact on subsequent run");
    return "SET bypass and following DELETE both SQLSTATE 25006; 1,000,000 orders remain";
  });

  await check("E2E-08 SELECT pg_sleep(60) then Esc", async () => {
    await setSql("SELECT pg_sleep(60)");
    await runAll();
    await until(() => [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Cancel"));
    await sleep(1000);
    await page.focus(".cm-content");
    const t0 = Date.now();
    await page.keyboard.press("Escape");
    await until(() => document.body.innerText.includes("Query cancelled"), 5000);
    const ms = Date.now() - t0;
    assert(ms < 1000, `cancel took ${ms} ms`);
    await sleep(300);
    eq(psql("select count(*) from pg_stat_activity where query ilike '%pg_sleep(60)%' and state='active' and pid<>pg_backend_pid()"), "0", "backend still sleeping");
    await page.screenshot({ path: `${SHOTS}/08-cancel.png` });
    return `cancelled in ${ms} ms; no backend left running`;
  });

  await check("E2E-11 export orders to CSV", async () => {
    const out = [];
    await openRel("orders");
    await page.evaluate(() => (window.__nextSavePath = "/tmp/slonview-e2e/11-orders-table.csv"));
    await page.click('button[title^="Export every row"]');
    await until(() => /Exported [\d,]+ rows to|Export failed/.test(document.body.innerText), 120000);
    const lines = execFileSync("wc", ["-l", "/tmp/slonview-e2e/11-orders-table.csv"], { encoding: "utf8" }).trim().split(/\s+/)[0];
    eq(lines, "1000001", "table export lines");
    out.push(`table export: ${lines} lines`);
    await page.click('[aria-label="Dismiss"]');
    await activateTab("Query 1");
    await setSql("SELECT * FROM orders");
    await runAll();
    await until(() => document.body.innerText.includes("Truncated at") && !!document.querySelector(".dvn-scroller"), 30000);
    const h = await page.evaluate(() => document.querySelector(".dvn-scroller").getBoundingClientRect().height);
    assert(h > 100, `SQL result grid collapsed (${h}px)`);
    await page.evaluate(() => (window.__nextSavePath = "/tmp/slonview-e2e/11-orders-sql.csv"));
    await clickText("Export CSV");
    // The results panel's own status ("Exported N rows", no " to <path>" — that is the table toast).
    await until(() => /Exported [\d,]+ rows(?! to)|Export failed/.test(document.body.innerText), 120000);
    const lines2 = execFileSync("wc", ["-l", "/tmp/slonview-e2e/11-orders-sql.csv"], { encoding: "utf8" }).trim().split(/\s+/)[0];
    eq(lines2, "1000001", "SQL export lines");
    out.push(`SQL result export: ${lines2} lines; result grid ${Math.round(h)}px tall`);
    await page.screenshot({ path: `${SHOTS}/11-export.png` });
    return out.join("; ");
  });

  await check("A reload restores tabs and SQL editor text", async () => {
    const before = {
      tabs: await tabStrip(),
      active: await page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.innerText.trim()),
    };
    assert(before.tabs.some((t) => t.endsWith("*")), `no preview tab to restore: ${before.tabs}`);
    await sleep(500); // editor save debounce
    await page.reload({ waitUntil: "networkidle0" });
    await until(() => document.querySelectorAll('[role="tab"]').length > 0, 15000);
    const after = {
      tabs: await tabStrip(),
      active: await page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.innerText.trim()),
    };
    eq(JSON.stringify(after), JSON.stringify(before), "tabs (with preview flag)");
    await activateTab("Query 1");
    eq(await page.$eval(".cm-content", (e) => e.innerText.trim()), "SELECT * FROM orders", "editor text");
    return `${after.tabs.length} tabs restored, active ${after.active}; editor text restored`;
  });

  await check("A history drawer lists runs", async () => {
    await clickText("History");
    await page.waitForSelector('input[aria-label="Search history"]');
    await sleep(500);
    const all = await page.evaluate(() => document.querySelector('input[aria-label="Search history"]').closest("div").parentElement.innerText);
    for (const s of ["SELECT * FROM orders", "SELECT pg_sleep(60)", "DELETE FROM orders"]) assert(all.includes(s), `history lacks ${s}`);
    await page.type('input[aria-label="Search history"]', "pg_sleep");
    await sleep(500);
    const found = await page.evaluate(() => document.querySelector('input[aria-label="Search history"]').closest("div").parentElement.innerText);
    assert(found.includes("pg_sleep") && !found.includes("DELETE FROM orders"), "search did not filter");
    await page.screenshot({ path: `${SHOTS}/A-history.png` });
    await page.click('[aria-label="Close history"]');
    return "3 runs listed (with error flags); search filters";
  });

  await check("V2-03 Format SQL: shortcut formats, one undo restores, bad SQL left alone", async () => {
    const doc = () => page.evaluate(() => document.querySelector(".cm-content").innerText);
    await setSql("select id,amount from orders where status='paid' and amount>100 order by id limit 3");
    await page.click(".cm-content");
    await page.keyboard.down("Alt");
    await page.keyboard.down("Shift");
    await page.keyboard.press("KeyF");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Alt");
    await until(() => document.querySelector(".cm-content").innerText.includes("\nFROM"), 5000);
    const formatted = await doc();
    for (const k of ["SELECT", "FROM", "WHERE", "ORDER BY", "LIMIT"]) assert(formatted.includes(k), `missing ${k}: ${formatted}`);
    assert(formatted.includes("status = 'paid'"), `literal mangled: ${formatted}`);
    // Formatted SQL still runs and returns the same rows.
    await runAll();
    await until(() => /3 rows/.test(document.body.innerText), 15000);
    // One undo restores the original text exactly.
    await page.click(".cm-content");
    await page.keyboard.down("Meta");
    await page.keyboard.press("z");
    await page.keyboard.up("Meta");
    eq((await doc()).trim(), "select id,amount from orders where status='paid' and amount>100 order by id limit 3", "after one undo");
    // Unparseable text: unchanged, toast shown.
    await setSql("select ((( from");
    await clickText("Format");
    await until(() => document.body.innerText.includes("Couldn't format"), 5000);
    eq((await doc()).trim(), "select ((( from", "bad SQL unchanged");
    return `formatted to ${formatted.split("\n").length} lines; ran 3 rows; one ⌘Z restores; parse error toast, text kept`;
  });

  await check("A allow writes, then UPDATE scratch_insert_target", async () => {
    await page.click('[aria-label="Disconnect E2E Fixture"]');
    await until(() => document.body.innerText.includes("E2E Fixture"));
    await page.evaluate(() => {
      const li = [...document.querySelectorAll('[role="option"]')].find((x) => x.innerText.includes("E2E Fixture"));
      li.querySelector('[aria-label="Edit E2E Fixture"]').click();
    });
    await page.waitForSelector("#cd-name");
    eq(await page.$eval("#cd-pw", (e) => e.value), "", "password field untouched");
    await page.click("#cd-allow-writes");
    await clickText("Save");
    await until(() => document.body.innerText.includes("WRITE"));
    const kc = await bridge("e2e_keychain_get", { id: connId });
    eq(kc, PASSWORD, "keychain password kept on edit");
    await page.evaluate(() => {
      const li = [...document.querySelectorAll('[role="option"]')].find((x) => x.innerText.includes("E2E Fixture"));
      li.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await until(() => document.querySelectorAll('[role="tab"]').length > 0, 15000);
    await activateTab("Query 1");
    await setSql(
      "INSERT INTO scratch_insert_target (id, customer_id, status, amount, note, created_at) VALUES (900000001, 1, 'paid', 1.00, 'e2e', now()); UPDATE scratch_insert_target SET note = 'e2e-upd' WHERE id = 900000001;",
    );
    await runAll();
    await until(() => [...document.querySelectorAll('button[role="tab"]')].map((b) => b.innerText).join() === "INSERT 1,UPDATE 1", 8000);
    eq(psql("select note from scratch_insert_target where id = 900000001"), "e2e-upd", "row updated");
    await setSql("DELETE FROM scratch_insert_target WHERE id = 900000001");
    await runAll();
    await until(() => document.body.innerText.includes("1 row affected"), 8000);
    eq(psql("select count(*) from scratch_insert_target"), "0", "scratch cleaned");
    return "Stored password kept on edit; INSERT 1, UPDATE 1 verified in psql; row removed";
  });

  await check("Grid edits: review SQL, apply transaction, verify psql", async () => {
    psql("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='scratch_insert_target'::regclass AND contype='p') THEN ALTER TABLE scratch_insert_target ADD PRIMARY KEY(id); END IF; END $$");
    await openRel("no_pk");
    const copyY = await gridTop();
    await page.mouse.click(350, copyY + 17, { button: "right" });
    await clickText("Copy as JSON", '[role="menuitem"], button');
    await until(() => { try { return JSON.parse(window.__clipboard).length === 1200; } catch { return false; } });
    eq(JSON.parse(await page.evaluate(() => window.__clipboard)).length, 1200, "whole column includes unloaded rows");
    psql("INSERT INTO scratch_insert_target(id,customer_id,status,amount,note,created_at) VALUES (900000004,1,'paid',1.00,'grid-before',now())");
    try {
      await openRel("scratch_insert_target");
      // Edit permissions load asynchronously; "Add row" is enabled only once editing is allowed.
      await until(() => [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Add row" && !b.disabled), 10000);
      // Canvas grid: widen the viewport so all six columns fit (no horizontal scroll offset),
      // then double-click across the first row and read each edit dialog's title until the
      // `note` editor opens. Double-click avoids depending on keyboard focus.
      await page.setViewport({ width: 1800, height: 900 });
      await sleep(400);
      const cellY = (await gridTop()) + HEADER + 12;
      const editLabel = () => page.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => d.getAttribute("aria-label") ?? "").find((l) => l.startsWith("Edit ")) ?? null);
      let found = false;
      for (let x = 340; x < 1780 && !found; x += 60) {
        await page.mouse.click(x, cellY, { clickCount: 2 });
        try {
          await until(() => !!document.querySelector("dialog[open]"), 1500);
        } catch {
          continue;
        }
        if ((await editLabel()) === "Edit note") { found = true; break; }
        await page.keyboard.press("Escape");
        await until(() => !document.querySelector("dialog[open]"));
      }
      assert(found, "no editable note cell found in the first row");
      await page.waitForSelector('[aria-label="Edit note"]');
      await page.$eval("#edit-value", e => e.select());
      await page.type("#edit-value", "grid-after 'quoted'");
      await clickText("Stage change");
      await clickText("Review changes");
      await page.waitForSelector('[aria-label="SQL to apply"]');
      const sql = await page.$eval('[aria-label="SQL to apply"]', e => e.textContent);
      assert(sql.includes('UPDATE "public"."scratch_insert_target"') && sql.includes("IS NOT DISTINCT FROM 'grid-before'") && sql.includes("grid-after ''quoted''"), sql);
      await page.screenshot({ path: `${SHOTS}/grid-edit-review.png` });
      await clickText("Apply");
      await until(() => document.body.innerText.includes("Applied 1 changes"));
      eq(psql("SELECT note FROM scratch_insert_target WHERE id=900000004"), "grid-after 'quoted'", "grid edit committed");
      await page.screenshot({ path: `${SHOTS}/grid-edit-applied.png` });
      return "reviewed Rust-generated SQL, transaction applied, psql confirmed quoted value";
    } finally {
      psql("DELETE FROM scratch_insert_target WHERE id=900000004");
      await page.setViewport({ width: 1400, height: 900 });
    }
  });

  await check("A connection time zone applies to browsing", async () => {
    // UTC first: the fixture server's own default may be Asia/Jakarta, so +00 proves the
    // zone comes from the profile.
    const out = [];
    for (const [tz, suffix] of [
      ["UTC", "+00"],
      ["Asia/Jakarta", "+07"],
    ]) {
      await page.click('[aria-label="Disconnect E2E Fixture"]');
      await until(() => document.body.innerText.includes("E2E Fixture"));
      await page.evaluate(() => {
        const li = [...document.querySelectorAll('[role="option"]')].find((x) => x.innerText.includes("E2E Fixture"));
        li.querySelector('[aria-label="Edit E2E Fixture"]').click();
      });
      await page.waitForSelector("#cd-tz");
      await page.$eval("#cd-tz", (e) => e.select());
      await page.keyboard.press("Backspace");
      await page.type("#cd-tz", tz);
      await clickText("Save");
      await until(() => !document.querySelector("#cd-tz") && document.body.innerText.includes("E2E Fixture"), 10000);
      eq((await bridge("list_profiles")).find((p) => p.id === connId).timeZone, tz, "saved timeZone");
      await page.evaluate(() => {
        const li = [...document.querySelectorAll('[role="option"]')].find((x) => x.innerText.includes("E2E Fixture"));
        li.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      });
      await until(() => document.querySelectorAll('[role="group"] button[role="treeitem"]').length > 5);
      await until((tz) => document.querySelector('[data-testid="session-tz"]')?.innerText.trim() === tz, 10000, tz);
      await openRel("orders");
      // After a reconnect the grid can mount before it takes keyboard focus, so the first
      // Cmd+C may land nowhere. Re-select and copy until the clipboard fills (max 4 tries).
      for (let attempt = 0; ; attempt++) {
        await selectRows(0, 0);
        await page.evaluate(() => (window.__clipboard = ""));
        await page.keyboard.down("Meta");
        await page.keyboard.press("c");
        await page.keyboard.up("Meta");
        try {
          await until(() => (window.__clipboard ?? "").includes("\n"), 2000);
          break;
        } catch (e) {
          if (attempt === 3) throw e;
        }
      }
      const [header, row] = (await page.evaluate(() => window.__clipboard)).split("\n");
      const createdAt = row.split("\t")[header.split("\t").indexOf("created_at")];
      assert(createdAt?.endsWith(suffix), `${tz}: first created_at ${createdAt} does not end with ${suffix}`);
      out.push(`${tz}: ${createdAt}`);
    }
    await page.screenshot({ path: `${SHOTS}/A-time-zone.png` });
    return out.join("; ");
  });

  await check("Status-bar time zone switch applies live (no disconnect)", async () => {
    // The previous check left the fixture connected with Asia/Jakarta. Switch zones purely
    // from the status bar popover and confirm orders.created_at re-renders without a reconnect.
    const switchZone = async (zone) => {
      await page.click('[data-testid="session-tz"]');
      await until(() => !!document.querySelector('[role="dialog"][aria-label="Session time zone"]'));
      const ok = await page.evaluate((z) => {
        // Match by zone id, not label: the Mac's own zone is labelled "<zone> (this Mac)".
        const b = [...document.querySelectorAll('[role="option"]')].find((x) => x.dataset.zone === z);
        b?.click();
        return !!b;
      }, zone);
      assert(ok, `no zone option ${zone}`);
      await until((z) => document.querySelector('[data-testid="session-tz"]')?.innerText.trim() === z, 10000, zone);
    };
    const createdSuffix = async () => {
      for (let attempt = 0; ; attempt++) {
        await selectRows(0, 0);
        await page.evaluate(() => (window.__clipboard = ""));
        await page.keyboard.down("Meta");
        await page.keyboard.press("c");
        await page.keyboard.up("Meta");
        try {
          await until(() => (window.__clipboard ?? "").includes("\n"), 2000);
          break;
        } catch (e) {
          if (attempt === 3) throw e;
        }
      }
      const [header, row] = (await page.evaluate(() => window.__clipboard)).split("\n");
      return row.split("\t")[header.split("\t").indexOf("created_at")];
    };
    const out = [];
    for (const [zone, suffix] of [["UTC", "+00"], ["Asia/Jakarta", "+07"]]) {
      await switchZone(zone);
      eq((await bridge("list_profiles")).find((p) => p.id === connId).timeZone, zone, "profile timeZone persisted without reconnect");
      const createdAt = await createdSuffix();
      assert(createdAt?.endsWith(suffix), `${zone}: created_at ${createdAt} does not end with ${suffix}`);
      out.push(`${zone}: ${createdAt}`);
    }
    await page.screenshot({ path: `${SHOTS}/A-time-zone-status-bar.png` });
    return out.join("; ");
  });

  await check("A UI layout: dark + light at 1100x700", async () => {
    const out = [];
    for (const scheme of ["dark", "light"]) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await page.setViewport({ width: 1100, height: 700 });
      await sleep(400);
      await openRel("all_types");
      await page.screenshot({ path: `${SHOTS}/UI-1100-${scheme}-table.png` });
      await activateTab("Query 1");
      await setSql("SELECT 1 AS a; SELECT * FROM paid_orders LIMIT 50;");
      await runAll();
      await until(() => document.body.innerText.includes("50 rows"), 8000);
      await page.screenshot({ path: `${SHOTS}/UI-1100-${scheme}-sql.png` });
      const overflow = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
      eq(JSON.stringify(overflow), JSON.stringify({ w: 1100, h: 700 }), `${scheme} page overflow`);
      out.push(`${scheme}: no page overflow`);
    }
    await page.setViewport({ width: 1400, height: 900 });
    return out.join("; ");
  });

  await check("Functions: expand public > Functions, open a plpgsql definition", async () => {
    await page.click('[aria-label^="Functions in public"]');
    const names = await page.evaluate(() =>
      [...document.querySelectorAll('[role="group"] [role="group"] button[role="treeitem"]')].map((b) => b.querySelector("span").textContent),
    );
    eq(names.filter((n) => n === "order_total").length, 2, "both order_total overloads listed");
    await page.evaluate(() => {
      [...document.querySelectorAll('[role="group"] [role="group"] button[role="treeitem"]')]
        .find((b) => b.querySelector("span").textContent === "customer_label")
        .click();
    });
    // SQL tabs stay mounted (hidden), so match only the visible editor.
    try {
      await until(
        () =>
          document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() === "customer_label(p_id bigint)" &&
          [...document.querySelectorAll(".cm-content")]
            .find((el) => el.offsetParent !== null)
            ?.textContent.includes("CREATE OR REPLACE FUNCTION public.customer_label"),
        10000,
      );
    } catch {
      const shown = await page.evaluate(() => [...document.querySelectorAll(".cm-content")].find((el) => el.offsetParent !== null)?.textContent);
      throw new Error(`definition tab not shown; visible editor: ${shown}`);
    }
    await page.screenshot({ path: `${SHOTS}/functions-definition.png` });
    return `${names.length} functions in public; definition tab "customer_label(p_id bigint)" shows CREATE OR REPLACE FUNCTION`;
  });

  await check("Types: expand public > Types, open the order_status enum definition", async () => {
    await page.click('[aria-label^="Types in public"]');
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('[aria-label^="Types in public"] + [role="group"] button[role="treeitem"]')].map((b) => b.querySelector("span").textContent),
    );
    for (const name of ["money_range", "order_status", "positive_amount"]) assert(rows.includes(name), `type ${name} listed (got ${rows.join(", ")})`);
    await page.evaluate(() => {
      [...document.querySelectorAll('[aria-label^="Types in public"] + [role="group"] button[role="treeitem"]')]
        .find((b) => b.querySelector("span").textContent === "order_status")
        .click();
    });
    const want = "CREATE TYPE public.order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');";
    try {
      await until(
        (want) =>
          document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() === "order_status" &&
          [...document.querySelectorAll(".cm-content")].find((el) => el.offsetParent !== null)?.textContent.includes(want),
        10000,
        want,
      );
    } catch {
      const shown = await page.evaluate(() => [...document.querySelectorAll(".cm-content")].find((el) => el.offsetParent !== null)?.textContent);
      throw new Error(`enum definition tab not shown; visible editor: ${shown}`);
    }
    await page.screenshot({ path: `${SHOTS}/types-enum-definition.png` });
    return `${rows.length} types in public; tab "order_status" shows ${want}`;
  });

  await check("SQL assist: column types, alias autocomplete, Explain shows a scan node", async () => {
    // SQL tabs stay mounted (hidden), so every probe targets the visible editor / panel.
    const visibleEditor = () => [...document.querySelectorAll(".cm-content")].find((el) => el.offsetParent !== null);
    await page.keyboard.down("Meta");
    await page.keyboard.press("t");
    await page.keyboard.up("Meta");
    await until(() => [...document.querySelectorAll(".cm-content")].some((el) => el.offsetParent !== null && el.textContent === ""), 5000);
    const editor = await page.evaluateHandle(visibleEditor);
    await editor.click();

    // Result columns carry type names (from the statement's row description), which ResultGrid aligns by.
    await page.evaluate((s) => document.execCommand("insertText", false, s), "SELECT 1::int AS i, 1.5::numeric(5,2) AS n, 'x'::text AS t");
    await page.keyboard.press("Escape");
    await page.keyboard.down("Meta");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Meta");
    const typed = await bridge("run_sql", { requestId: "e2e-types", connId, sql: "SELECT 1::int AS i, 1.5::numeric(5,2) AS n, 'x'::text AS t, ARRAY[1,2] AS a", maxRows: 10 });
    eq(typed[0].columns.map((c) => c.typeName).join("|"), "integer|numeric(5,2)|text|integer[]", "result column types");
    await until(() => document.body.innerText.includes("1 row"), 8000);

    // Alias completion: `o.` lists orders' columns.
    await editor.click();
    await page.keyboard.down("Meta");
    await page.keyboard.press("a");
    await page.keyboard.up("Meta");
    await page.keyboard.press("Backspace");
    await page.evaluate((s) => document.execCommand("insertText", false, s), "SELECT  FROM orders o WHERE true");
    await page.keyboard.press("Home");
    for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.type("o.");
    await until(() => document.querySelectorAll(".cm-tooltip-autocomplete li").length > 0, 5000);
    const options = await page.evaluate(() => [...document.querySelectorAll(".cm-tooltip-autocomplete li .cm-completionLabel")].map((l) => l.textContent));
    for (const name of ["id", "customer_id", "status", "amount", "created_at"]) assert(options.includes(name), `o. completion missing ${name}: ${options}`);
    await page.keyboard.press("Escape");

    // Explain (plan only, ⌘E) on a SELECT shows a scan node of orders.
    await page.keyboard.down("Meta");
    await page.keyboard.press("a");
    await page.keyboard.up("Meta");
    await page.keyboard.press("Backspace");
    await page.evaluate((s) => document.execCommand("insertText", false, s), "SELECT * FROM orders WHERE id = 42");
    await page.keyboard.press("Escape");
    await page.keyboard.down("Meta");
    await page.keyboard.press("e");
    await page.keyboard.up("Meta");
    await until(() => [...document.querySelectorAll('[data-testid="plan-view"]')].some((el) => el.offsetParent !== null), 8000);
    const nodes = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="plan-view"] tr[data-node-type]')].filter((r) => r.offsetParent !== null).map((r) => r.innerText.split("\n")[0]),
    );
    assert(nodes.some((n) => /(Seq|Index|Index Only|Bitmap Heap) Scan/.test(n) && n.includes("public.orders")), `no scan node on orders: ${nodes}`);
    assert(await page.evaluate(() => document.body.innerText.includes("Plan only, not executed")), "plan-only banner");
    await page.screenshot({ path: `${SHOTS}/sql-assist-explain.png` });
    await page.keyboard.down("Meta");
    await page.keyboard.press("w");
    await page.keyboard.up("Meta");
    return `types integer|numeric(5,2)|text|integer[]; o. offers ${options.length} columns; plan: ${nodes.join(" > ")}`;
  });

  await check("Multi-connection: two connections, orders in each, disconnect closes only its tabs", async () => {
    // Second profile on the same fixture DB, read-only and in another colour. Trust auth; the
    // password argument is omitted so the credential store is not touched.
    const base = (await bridge("list_profiles")).find((p) => p.id === connId);
    const secondId = crypto.randomUUID();
    await bridge("save_profile", { profile: { ...base, id: secondId, name: "E2E Second", readOnly: true, color: "#8e4ec6" } });
    try {
      // Reload picks up the new profile; E2E Fixture reconnects on its own.
      await page.reload({ waitUntil: "networkidle0" });
      await until(() => document.querySelectorAll('[role="group"] button[role="treeitem"]').length > 5);
      await clickText("Open another connection…");
      await page.waitForSelector('[role="listbox"][aria-label="Saved connections"]');
      await page.evaluate(() => {
        const li = [...document.querySelectorAll('[role="option"]')].find((x) => x.innerText.includes("E2E Second"));
        li.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      });
      await until(() => document.querySelectorAll('[role="group"] button[role="treeitem"]').length > 5 && !document.querySelector('[aria-label="Saved connections"]'));
      const open = await page.$$eval('[aria-label="Open connections"] li', (lis) => lis.map((l) => l.innerText.replace(/\s+/g, " ").trim()));
      eq(JSON.stringify(open), JSON.stringify(["E2E Fixture WRITE", "E2E Second READ-ONLY"]), "open connections in the switcher");
      await openRel("orders");
      eq(await page.$eval('[data-testid="status-conn"]', (e) => e.innerText.includes("E2E Second")), true, "status bar shows E2E Second");
      // Back to E2E Fixture via the switcher, then orders there too.
      await page.evaluate(() =>
        [...document.querySelectorAll('[aria-label="Open connections"] button[aria-current], [aria-label="Open connections"] li > button:first-child')]
          .find((b) => b.innerText.includes("E2E Fixture"))
          .click(),
      );
      await until(() => !!document.querySelector('[aria-label="Open connections"] button[aria-current="true"]')?.innerText.includes("E2E Fixture"));
      await openRel("orders");
      const ordersTabs = () =>
        page.$$eval('[role="tab"]', (tabs) =>
          tabs
            .filter((t) => t.innerText.trim() === "orders")
            .map((t) => ({ conn: t.dataset.conn, dot: getComputedStyle(t.querySelector("span.rounded-full")).backgroundColor, tip: t.title })),
        );
      const both = await ordersTabs();
      eq(both.length, 2, "two orders tabs in one strip");
      eq(new Set(both.map((t) => t.conn)).size, 2, "orders tabs belong to different connections");
      assert(both[0].dot !== both[1].dot, `dots should differ: ${both.map((t) => t.dot)}`);
      assert(both.some((t) => t.tip.includes("E2E Second")) && both.some((t) => t.tip.includes("E2E Fixture")), `tooltips name the connection: ${both.map((t) => t.tip)}`);
      eq(await page.$eval('[data-testid="status-conn"]', (e) => e.innerText.includes("E2E Fixture")), true, "status bar follows the active tab");
      // Activating the E2E Second tab switches the sidebar to it.
      await page.evaluate((id) => {
        const el = [...document.querySelectorAll('[role="tab"]')].find((x) => x.dataset.conn === id);
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      }, secondId);
      await until(() => !!document.querySelector('[aria-label="Open connections"] button[aria-current="true"]')?.innerText.includes("E2E Second"));
      await page.screenshot({ path: `${SHOTS}/multi-conn.png` });
      const fixtureTabs = await page.$$eval('[role="tab"]', (tabs, id) => tabs.filter((t) => t.dataset.conn === id).length, connId);
      await page.click('[aria-label="Disconnect E2E Second"]');
      await until((id) => ![...document.querySelectorAll('[role="tab"]')].some((t) => t.dataset.conn === id), 5000, secondId);
      const left = await page.$$eval('[role="tab"]', (tabs, id) => tabs.filter((t) => t.dataset.conn === id).length, connId);
      eq(left, fixtureTabs, "E2E Fixture tabs untouched");
      const switcher = await page.$$eval('[aria-label="Open connections"] li', (lis) => lis.map((l) => l.innerText.replace(/\s+/g, " ").trim()));
      eq(JSON.stringify(switcher), JSON.stringify(["E2E Fixture WRITE"]), "only E2E Fixture stays open");
      return `two orders tabs (dots ${both.map((t) => t.dot).join(" vs ")}); disconnecting E2E Second closed its tab, ${left} E2E Fixture tabs kept`;
    } finally {
      await bridge("delete_profile", { id: secondId });
    }
  });

  await check("A zero console errors", async () => {
    eq(consoleErrors.length, 0, `console errors: ${consoleErrors.join(" | ")}`);
    return "0 console/page errors";
  });

  // Cleanup: profile + credential-store entry.
  await page.click('[aria-label="Disconnect E2E Fixture"]').catch(() => {});
  if (connId) await bridge("delete_profile", { id: connId });
} finally {
  await browser.close();
  writeFileSync(`${SHOTS}/ui-results.json`, JSON.stringify(results, null, 2));
}

const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
