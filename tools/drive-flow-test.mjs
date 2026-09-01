/**
 * Photographs from a shared Drive folder.
 *
 * The way they actually arrive is a link in an email, and the alternative was
 * downloading thirty files to a laptop so they could be dragged back in.
 *
 * Read with an API key, so only a folder shared as "anyone with the link" opens
 * - which is how a link sent to somebody outside the organisation is shared
 * already. The error paths matter more than usual here because Drive is
 * deliberately unhelpful about them: it answers 403 both for a folder that is
 * private and for one that does not exist, since confirming an id exists would
 * leak it. So the message has to name both causes, and this checks that it does
 * rather than sending somebody to fix sharing on a typo.
 *
 * The happy path needs a real folder. Set DRIVE_TEST_FOLDER to a share link and
 * it is exercised; without one the error paths still are, and the run says which
 * half it covered.
 */
import { chromium } from "playwright";
import { chooseMode } from "./lib/flow.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const FOLDER = process.env.DRIVE_TEST_FOLDER ?? "";

const available = await fetch(`${BASE}/api/drive`)
  .then((r) => r.json())
  .then((d) => Boolean(d.available))
  .catch(() => false);

if (!available) {
  console.log(
    JSON.stringify(
      {
        verdict:
          "SKIPPED - no Drive key. Set GOOGLE_DRIVE_API_KEY in .env.local, or an unrestricted GOOGLE_MAPS_API_KEY",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const ask = (url) =>
  fetch(`${BASE}/api/drive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// --- Things that are not a Drive folder ---
const notDrive = await ask("123 Main St, Seattle, WA 98101");
check("an address is refused", notDrive.status === 422, `${notDrive.status}`);
check("and says what to paste instead", /Drive link/i.test(notDrive.body.message ?? ""),
  notDrive.body.message);

const zillow = await ask("https://www.zillow.com/homedetails/x/12345_zpid/");
check("a listing link is refused", zillow.status === 422, `${zillow.status}`);

// --- A well-formed link to something we cannot open ---
const closed = await ask("https://drive.google.com/drive/folders/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuV");
check("an unreadable folder is a 403", closed.status === 403, `${closed.status}`);
// Both causes, because Drive will not tell us which one it is.
check("and names the link being wrong", /link is wrong/i.test(closed.body.message ?? ""),
  closed.body.message);
check("as well as the sharing setting", /shared publicly|Anyone with the link/i.test(closed.body.message ?? ""),
  closed.body.message);

// --- The box only exists when it can work ---
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${BASE}/new`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    await chooseMode(page);
await page.waitForTimeout(1200);
await page.locator("summary").first().click();
await page.waitForTimeout(500);

const box = page.getByPlaceholder(/Drive folder link/i);
check("the Drive box is offered", (await box.count()) === 1);
check(
  "and explains the sharing requirement without being asked",
  /anyone with the link/i.test(await page.locator("body").innerText()),
);

// A bad link must surface the message in the UI, not just in the network tab.
await box.fill("https://drive.google.com/drive/folders/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuV");
await page.getByRole("button", { name: "Get them" }).click();
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1000);
  if (/link is wrong/i.test(await page.locator("body").innerText())) break;
}
check(
  "an unreadable folder is explained on screen",
  /link is wrong/i.test(await page.locator("body").innerText()),
  (await page.locator("body").innerText()).slice(0, 200),
);

// --- The happy path, when there is a folder to point at ---
let imported = 0;
if (FOLDER) {
  const listed = await ask(FOLDER);
  check("the folder opens", listed.status === 200, JSON.stringify(listed.body).slice(0, 160));
  check("and holds photographs", (listed.body.files ?? []).length > 0);

  if (listed.status === 200 && (listed.body.files ?? []).length > 0) {
    await page.goto(`${BASE}/new`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    await chooseMode(page);
    await page.waitForTimeout(1000);
    await page.locator("summary").first().click();
    await page.waitForTimeout(400);
    await page.getByPlaceholder(/Drive folder link/i).fill(FOLDER);
    await page.getByRole("button", { name: "Get them" }).click();

    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(2000);
      imported = await page.locator("img").count();
      if (imported >= listed.body.files.length) break;
    }
    check(
      "every photograph reaches the wizard",
      imported >= listed.body.files.length,
      `${imported} of ${listed.body.files.length}`,
    );
    check(
      "and the tour is saved with them",
      Boolean(
        await page.evaluate(() =>
          JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]").length,
        ),
      ),
    );
  }
}

check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  JSON.stringify(
    {
      importedFromRealFolder: FOLDER ? imported : null,
      errors,
      verdict:
        failures > 0
          ? `BROKEN - ${failures} check(s) failed`
          : FOLDER
            ? `DRIVE FLOW OK - ${imported} photographs pulled from a shared folder, and every error path explained`
            : "DRIVE FLOW OK - error paths explained; set DRIVE_TEST_FOLDER to a share link to exercise a real folder",
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
