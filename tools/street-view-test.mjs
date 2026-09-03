/**
 * The house on its street.
 *
 * A property whose site carries the frame, two named roads and three
 * neighbours - one of them a garage on this lot - opens with a lawn, the
 * roads as asphalt with their names where they pass the house, the
 * neighbours as grey masses, and no photograph on any of it. A site without
 * a frame, as every older house has, draws none of this and throws nothing.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const LAT = 47.6231;
const LON = -122.2969;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

// Plan metres to the map, for a frame with no turn and the house's corner
// eight metres east and six south of the centre.
const frame = { centre: { lat: LAT, lon: LON }, rotationDeg: 0, offset: [-8, -6], scale: 1 };
const toLatLon = (x, y) => {
  const lx = x + frame.offset[0];
  const ly = y + frame.offset[1];
  return [LAT - ly / 111_320, LON + lx / (Math.cos((LAT * Math.PI) / 180) * 111_320)];
};
const ring = (x0, y0, x1, y1) => [toLatLon(x0, y0), toLatLon(x1, y0), toLatLon(x1, y1), toLatLon(x0, y1)];

const property = (id, site) => ({
  id,
  label: "Street Fixture",
  displayUnits: "ft",
  plan: {
    scaleRef: { px: 1, meters: 1 },
    rooms: [
      { id: "living", label: "Living Room", polygon: [[0, 0], [6, 0], [6, 5], [0, 5]], ceilingHeight: 2.7, level: 0 },
      { id: "kitchen", label: "Kitchen", polygon: [[6, 0], [10, 0], [10, 5], [6, 5]], ceilingHeight: 2.7, level: 0 },
    ],
    openings: [{ id: "d", kind: "door", between: ["living", "kitchen"], at: [6, 2.5], width: 0.9 }],
  },
  nodes: [],
  condition: {},
  houseCondition: {},
  rates: {},
  site,
});

const withStreet = property("street-yes", {
  lat: LAT,
  lon: LON,
  planXBearing: 90,
  frame,
  streets: [
    // Maple Street along y = -12, split at a junction into two ways.
    { name: "Maple Street", kind: "residential", ways: [[toLatLon(-40, -12), toLatLon(5, -12)], [toLatLon(5, -12), toLatLon(50, -12)]] },
    // Oak Avenue running north-south to the east.
    { name: "Oak Avenue", kind: "tertiary", ways: [[toLatLon(30, -40), toLatLon(30, 40)]] },
  ],
  buildings: [
    { ring: ring(-20, 0, -12, 8), kind: null, levels: 2 },
    { ring: ring(16, -2, 24, 8), kind: null, levels: null, heightM: 5 },
    // A garage on this lot, beside the house.
    { ring: ring(11.5, 1, 14.5, 7), kind: "garage" },
  ],
  attribution: ["Map data © OpenStreetMap contributors (ODbL)"],
});
const withoutFrame = property("street-no", { lat: LAT, lon: LON, planXBearing: 90 });

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const open = async (doc) => {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.evaluate((doc) => {
    localStorage.setItem(`mattermatt:property:${doc.id}`, JSON.stringify(doc));
    const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
    if (!index.includes(doc.id)) index.push(doc.id);
    localStorage.setItem("mattermatt:index", JSON.stringify(index));
  }, doc);
  await page.goto(`${BASE}/tour/${doc.id}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__scene && window.__scene.meshes > 0, { timeout: 45_000 });
  await page.waitForTimeout(2500);
  return page.evaluate(() => window.__scene);
};

const scene = await open(withStreet);
const by = scene.bySurface ?? {};
check("there is ground under the house", (by.ground ?? 0) >= 2, JSON.stringify(by));
check("the roads are drawn", (by.street ?? 0) > 0, JSON.stringify(by));
check("with kerbs", (by.kerb ?? 0) > 0);
check("the neighbours are drawn", (by.neighbour ?? 0) > 0, JSON.stringify(by));
check("the garage on this lot is an outbuilding, not a neighbour", (by.outbuilding ?? 0) > 0, JSON.stringify(by));
check("no photograph is on any of it", scene.photoTextures === 0, `${scene.photoTextures}`);
check("nothing glows", scene.emissive === 0, `${scene.emissive}`);
const names = await page.evaluate(() => [...document.querySelectorAll("[data-street-name]")].map((el) => el.textContent?.trim()));
check("the streets are named where they pass the house", names.includes("Maple Street") && names.includes("Oak Avenue"), names.join(", "));
check("a street name is not a room label", !names.some((n) => /sq ft$/.test(n ?? "")));
// Readable from the house: a road along the front reads left to right with
// its top toward the road's far side; the one to the east runs away from you.
const turns = await page.evaluate(() =>
  Object.fromEntries([...document.querySelectorAll("[data-street-name]")].map((el) => [el.textContent?.trim(), Number(el.getAttribute("data-street-turn"))])),
);
check("the name along the front is not turned", turns["Maple Street"] === 0, JSON.stringify(turns));
check("the name to the east runs away from the house", turns["Oak Avenue"] === 90, JSON.stringify(turns));
check("the map is credited", (await page.locator("[data-site-attribution]").count()) === 1);
check("the lot is called an estimate", /estimate/i.test(await page.locator("[data-site-attribution]").innerText()));
await page.screenshot({ path: "shots/ST1-street-dollhouse.png" });

// The neighbours can be put away.
await page.locator("[data-neighbours-toggle]").click();
await page.waitForTimeout(1500);
const hidden = await page.evaluate(() => window.__scene?.bySurface ?? {});
check("the neighbours toggle off", (hidden.neighbour ?? 0) === 0, JSON.stringify(hidden));
check("and the house's own garage stays", (hidden.outbuilding ?? 0) > 0);

// An older house: a site with no frame draws nothing new.
const bare = await open(withoutFrame);
const bareBy = bare.bySurface ?? {};
check("a site without a frame draws no ground", (bareBy.ground ?? 0) === 0 && (bareBy.street ?? 0) === 0, JSON.stringify(bareBy));
check("and offers no toggle", (await page.locator("[data-neighbours-toggle]").count()) === 0);

check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
console.log(
  failures === 0
    ? "STREET OK - the house sits on its lot between its neighbours with its roads named, and an older house is untouched"
    : `STREET BROKEN - ${failures} failure(s)`,
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
