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
  try {
    await page.waitForFunction(() => window.__scene && window.__scene.meshes > 0, { timeout: 45_000 });
  } catch (error) {
    // Say what the page said, or a timeout is all anyone learns.
    console.log("  the scene never appeared:", errors.slice(0, 3).join(" | ") || "no page errors");
    console.log("  page said:", (await page.evaluate(() => document.body.innerText)).slice(0, 240).replace(/\n/g, " | "));
    throw error;
  }
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

// --- from the kerb ---
//
// The Street button stands the camera at the kerb at eye height, looking at
// the house with its facades solid. The camera's own readout says where it is.
/**
 * Wait for the camera to stop.
 *
 * A full second of stillness, not two close samples: without a GPU the eased
 * flight advances in steps of a few hundred milliseconds, and two samples in
 * one step read as "settled" halfway there.
 */
const settle = async () => {
  const recent = [];
  for (let i = 0; i < 100; i++) {
    await page.waitForTimeout(250);
    const now = await page.evaluate(() => window.__camera?.position ?? null);
    if (!now) continue;
    recent.push(now);
    if (recent.length > 4) recent.shift();
    if (recent.length === 4 && recent.every((p) => Math.hypot(p[0] - now[0], p[1] - now[1], p[2] - now[2]) < 0.01)) return now;
  }
  return recent[recent.length - 1] ?? null;
};
// The street orbit is the only thing that looks at the house 1.2m up; the
// scene readout that names the mode lags a second behind it.
const lookingFromStreet = () => page.waitForFunction(() => window.__camera?.target?.[1] === 1.2, { timeout: 20_000 }).catch(() => {});
const lookingFromAbove = () => page.waitForFunction(() => window.__camera?.target?.[1] === 0, { timeout: 20_000 }).catch(() => {});
await page.locator("[data-street-toggle]").click();
await lookingFromStreet();
await page.waitForFunction(() => window.__scene?.mode === "street", { timeout: 20_000 }).catch(() => {});
const kerbPos = await settle();
const kerbCam = await page.evaluate(() => window.__camera);
check("the street view is a mode of its own", (await page.evaluate(() => window.__scene?.mode)) === "street");
check("the camera stands at eye height", kerbPos !== null && kerbPos[1] > 0.8 && kerbPos[1] < 3, `${kerbPos}`);
check("out on the street, not in the house",
  kerbCam !== null && Math.hypot(kerbCam.position[0] - kerbCam.target[0], kerbCam.position[2] - kerbCam.target[2]) >= 6,
  JSON.stringify(kerbCam));
// The road is along y = -12, in front of the -y side: the kerb is north of the house.
check("on the road side of the house", kerbPos !== null && kerbPos[2] < 0, `${kerbPos}`);
const streetScene = await page.evaluate(() => window.__scene);
check("the roof is there from the street", (streetScene.bySurface?.roof ?? 0) > 0);
check("and the names are", (await page.locator("[data-street-name]").count()) === 2);
await page.screenshot({ path: "shots/ST2-street-view.png" });

// Drag walks round; the wheel comes closer but never inside the lot line.
const box = await page.locator("canvas").first().boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 220, box.y + box.height / 2, { steps: 20 });
await page.mouse.up();
const dragged = await settle();
check("dragging walks round the house", dragged !== null && kerbPos !== null && Math.hypot(dragged[0] - kerbPos[0], dragged[2] - kerbPos[2]) > 1, `${kerbPos} → ${dragged}`);
check("and stays at eye height", dragged !== null && dragged[1] > 0.5 && dragged[1] < 6, `${dragged}`);
for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -400);
const closer = await settle();
const closerCam = await page.evaluate(() => window.__camera);
check("the wheel comes closer but not into the house",
  closerCam !== null && Math.hypot(closerCam.position[0] - closerCam.target[0], closerCam.position[2] - closerCam.target[2]) >= 5.9,
  JSON.stringify(closerCam));
void closer;

// The tour opens from the kerb.
await page.locator("[data-tour-toggle]").click();
await page.waitForTimeout(900);
const caption = await page.locator("[data-tour-caption]").innerText().catch(() => "");
check("the tour's first shot is the house from the street", caption.trim() === "Street Fixture", caption);
await page.locator("[data-tour-toggle]").click();
await page.waitForTimeout(500);

// The tour runs in the dollhouse, so stopping it leaves us there - and the
// camera has to come back up, not stay down on the kerb's orbit.
await page.waitForFunction(() => window.__scene?.mode === "dollhouse", { timeout: 20_000 }).catch(() => {});
check("the tour hands back to the dollhouse", (await page.evaluate(() => window.__scene?.mode)) === "dollhouse");
await lookingFromAbove();
const up = await settle();
check("and the camera comes back up", up !== null && up[1] > 5, `${up}`);

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
