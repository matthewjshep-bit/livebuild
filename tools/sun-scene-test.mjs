/**
 * Daylight in the scene, and the honesty of showing it at all.
 *
 * The solar model itself is checked against textbook figures in sun-test.ts.
 * What that cannot tell you is whether the house is actually lit by it, or
 * whether a slider that claims to move the sun moves anything.
 *
 * The second assertion is the one worth having: a model with no coordinates
 * must not offer a daylight control. A sun that moves and means nothing is
 * decoration pretending to be information, and it is the kind of thing nobody
 * notices is wrong.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

// A house with no coordinates offers no daylight control.
await page.goto(`${BASE}/tour/demo-house`, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 25_000 });
await page.waitForTimeout(4000);
check("a house with no site has no daylight control",
  (await page.locator("[data-sun-altitude]").count()) === 0);

// Now the same house, given a site in Seattle.
const seeded = await page.evaluate(async () => {
  const raw = await fetch("/properties/demo-house/property.json").then((r) => r.json());
  const withSite = {
    ...raw,
    id: "sun-fixture",
    label: "Sun fixture",
    site: { lat: 47.62, lon: -122.3, planXBearing: 90 },
  };
  window.localStorage.setItem("livebuild:property:sun-fixture", JSON.stringify(withSite));
  // The real index key. The tour page happens to load a property directly, so
  // an earlier version of this passed with the wrong key - which would have
  // left the fixture invisible everywhere else in the app.
  const index = JSON.parse(window.localStorage.getItem("livebuild:index") ?? "[]");
  if (!index.includes("sun-fixture")) index.push("sun-fixture");
  window.localStorage.setItem("livebuild:index", JSON.stringify(index));
  return true;
});
check("the fixture was seeded", seeded);

await page.goto(`${BASE}/tour/sun-fixture`, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 25_000 });
await page.waitForTimeout(4000);

const readout = page.locator("[data-sun-altitude]");
check("a house with a site gets a daylight control", (await readout.count()) === 1);

const altitudeAt = async () => {
  const text = await readout.innerText();
  const m = /Sun (-?\d+)° up/.exec(text);
  return m ? Number(m[1]) : null;
};

// Midsummer in Seattle: high late morning, below the horizon at four in the
// morning. Both come from the model that sun-test.ts already pinned down, so
// what is being checked here is that the page is really driving it.
const time = page.getByLabel("Time of day");
await time.fill("10.5");
await page.waitForTimeout(700);
const morning = await altitudeAt();
check("the late-morning sun is well up", morning !== null && morning > 40, `${morning}`);

await time.fill("4");
await page.waitForTimeout(700);
const dawn = await altitudeAt();
check("the sun is low at four in the morning", dawn !== null && dawn < 10, `${dawn}`);
check("moving the slider moves the sun", morning !== dawn, `${morning} then ${dawn}`);

// Winter must differ from summer, or the date control is inert.
await time.fill("12");
await page.getByLabel("Day of year").fill("355");
await page.waitForTimeout(700);
const winter = await altitudeAt();
await page.getByLabel("Day of year").fill("172");
await page.waitForTimeout(700);
const summer = await altitudeAt();
check("midsummer noon is far higher than midwinter",
  summer !== null && winter !== null && summer - winter > 35,
  `${summer} vs ${winter}`);

check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  failures === 0
    ? `SUN SCENE OK - no site means no control; with one, noon runs ${winter}° in December to ${summer}° in June`
    : `SUN SCENE BROKEN - ${failures} failures`,
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
