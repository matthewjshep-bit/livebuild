/**
 * The surroundings land on the plan where they are on the map.
 *
 * `frame-test` already proves the projection; this proves the thing built on
 * it: a stored site becomes streets and neighbours in plan metres, a site
 * without a frame becomes nothing, and the road geometry is the width it says.
 */
import { prepareFootprint } from "../src/lib/plan/footprint";
import { buildingHeight, roadWidth, siteInPlan } from "../src/lib/site/plan-site";
import { ribbonGeometry, offsetWay } from "../src/lib/model/site-geometry";
import { Site } from "../src/lib/schema";
import type { Vec2 } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const LAT = 47.6231;
const LON = -122.2969;
function houseRing(lat: number, lon: number, turnDeg: number): Array<[number, number]> {
  const mLat = 1 / 111_320;
  const mLon = 1 / (Math.cos((lat * Math.PI) / 180) * 111_320);
  const r = (turnDeg * Math.PI) / 180;
  const corners: Vec2[] = [[0, 0], [16, 0], [16, 9], [0, 9]];
  return corners.map(([x, y]) => {
    const rx = x * Math.cos(r) - y * Math.sin(r);
    const ry = x * Math.sin(r) + y * Math.cos(r);
    return [lat + ry * mLat, lon + rx * mLon] as [number, number];
  });
}

// --- a stored site projects ---
{
  const fp = prepareFootprint(houseRing(LAT, LON, 20), undefined, 6);
  const site = Site.parse({
    lat: LAT,
    lon: LON,
    planXBearing: 90 + fp.rotationDeg,
    frame: fp.frame,
    streets: [
      { name: "Maple Street", kind: "residential", ways: [[[LAT + 0.0009, LON - 0.002], [LAT + 0.0009, LON + 0.002]]] },
    ],
    buildings: [
      { ring: [[LAT + 0.0003, LON + 0.0006], [LAT + 0.0003, LON + 0.0008], [LAT + 0.0004, LON + 0.0008], [LAT + 0.0004, LON + 0.0006]], kind: null, levels: 2 },
    ],
    attribution: ["Map data © OpenStreetMap contributors (ODbL)"],
  });
  check("the schema keeps the new fields", Array.isArray(site.streets) && Array.isArray(site.buildings));
  const inPlan = siteInPlan(site);
  check("a site with a frame projects", inPlan !== null);
  if (inPlan) {
    const [a, b] = inPlan.streets[0].ways[0];
    const onPlan = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    const off = Math.abs(((onPlan % 90) + 90) % 90);
    check("a street lands at its true angle to the squared-up house", Math.min(off, 90 - off) > 15 && Math.min(off, 90 - off) < 25, `${off.toFixed(1)}deg`);
    const ys = fp.outline.map((p) => p[1]);
    const xs = fp.outline.map((p) => p[0]);
    check("and outside the building", a[1] < Math.min(...ys) || a[1] > Math.max(...ys) || a[0] < Math.min(...xs) || a[0] > Math.max(...xs));
    check("a neighbour projects to a polygon", inPlan.buildings[0].outline.length === 4);
    check("its height comes from its storeys", Math.abs(inPlan.buildings[0].heightM - 6.4) < 1e-9, `${inPlan.buildings[0].heightM}`);
    check("the credit travels with it", inPlan.attribution.length === 1);
  }
}

// --- without a frame there is nothing ---
{
  const bare = Site.parse({ lat: LAT, lon: LON, planXBearing: 90 });
  check("an older site parses without the new fields", bare.frame == null && !bare.streets);
  check("and projects to nothing", siteInPlan(bare) === null);
  check("nor does no site", siteInPlan(null) === null);
}

// --- widths and heights ---
{
  check("a residential road is 7m", roadWidth("residential") === 7);
  check("a primary road is wider", roadWidth("primary") > roadWidth("tertiary") && roadWidth("tertiary") > roadWidth("residential"));
  check("an unknown kind is a residential road", roadWidth(null) === 7 && roadWidth("weird") === 7);
  check("metres beat storeys", buildingHeight({ heightM: 4.5, levels: 3 }) === 4.5);
  check("storeys beat the guess", Math.abs(buildingHeight({ levels: 3 }) - 9.6) < 1e-9);
  check("a garage is low", buildingHeight({ kind: "garage" }) === 2.8 && buildingHeight({ kind: "house" }) === 6);
}

// --- the road geometry ---
{
  const g = ribbonGeometry([[0, 0], [10, 0]], 7, 0)!;
  const pos = g.getAttribute("position");
  const zs: number[] = [];
  for (let i = 0; i < pos.count; i++) zs.push(pos.getZ(i));
  check("a straight way is a quad of the stated width", Math.abs(Math.max(...zs) - Math.min(...zs) - 7) < 1e-6, `${Math.max(...zs) - Math.min(...zs)}`);
  const n = g.getAttribute("normal");
  let up = true;
  for (let i = 0; i < n.count; i++) if (n.getY(i) < 0.99) up = false;
  check("and every face looks up", up);
  const bent = ribbonGeometry([[0, 0], [10, 0], [10, 10]], 7, 0)!;
  check("a bend gets a disc at the join", bent.getAttribute("position").count > pos.count + 6);
  const left = offsetWay([[0, 0], [10, 0]], 2);
  check("a way offsets sideways by the amount asked", Math.abs(left[0][1] - 2) < 1e-9 && Math.abs(left[1][1] - 2) < 1e-9, `${left}`);
}

console.log(
  failures === 0
    ? "STREETS ON PLAN OK - a stored site projects to streets and neighbours at their true angle, an older site projects to nothing, and a road is as wide as its kind"
    : `STREETS ON PLAN BROKEN - ${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
