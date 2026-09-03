/**
 * The lot is where the map says the house's ground is.
 *
 * No data source has the parcel, so the lot is derived: the nearest road is
 * the front, setbacks fill the other sides, a neighbour or a second road
 * shortens them, and the lawn never lies on the asphalt. Each of those is a
 * rule that can be wrong on its own, so each is checked on its own.
 */
import { deriveLot } from "../src/lib/site/lot";
import { pointInPolygon, signedArea } from "../src/lib/plan/geometry";
import type { PlanSite } from "../src/lib/site/plan-site";
import type { Vec2 } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

// A 10 by 8 house with its corner at the origin.
const house = { x0: 0, y0: 0, x1: 10, y1: 8 };
const street = (name: string, kind: string, ways: Vec2[][]) => ({ name, kind, ways });
const site = (streets: PlanSite["streets"], buildings: PlanSite["buildings"] = []): PlanSite => ({
  streets,
  buildings,
  attribution: [],
});
const xs = (poly: Vec2[]) => poly.map((p) => p[0]);
const ys = (poly: Vec2[]) => poly.map((p) => p[1]);
const containsHouse = (poly: Vec2[]) =>
  [[0, 0], [10, 0], [10, 8], [0, 8]].every((c) => pointInPolygon(c as Vec2, poly));

// --- the nearest road is the front ---
{
  // Maple Street runs along y = -12, in front of the house's -y side.
  const lot = deriveLot({ house, site: site([street("Maple Street", "residential", [[[-40, -12], [50, -12]]])]) });
  check("the road decides the front", lot.front.side === "-y", lot.front.side);
  check("and is named", lot.front.street === "Maple Street");
  // 12m to the centreline, a 7m road, a 1.5m verge: the lot line is 7m out.
  check("the front setback is the distance to the road edge", Math.abs(lot.setbacks.front - 7) < 0.01, `${lot.setbacks.front}`);
  check("the kerb is on the near edge of the road", lot.front.kerb !== null && Math.abs(lot.front.kerb![1] - -8.5) < 0.01,
    `${lot.front.kerb}`);
  check("the lot contains the house", containsHouse(lot.polygon));
  check("and reaches the front lot line", Math.abs(Math.min(...ys(lot.polygon)) - -7) < 0.01, `${Math.min(...ys(lot.polygon))}`);
  check("the rear takes the default", Math.abs(lot.setbacks.rear - 9) < 0.01);
  check("the door is in the middle of the front wall", lot.frontDoor[1] === 0 && Math.abs(lot.frontDoor[0] - 5) < 0.01);
  check("it says it is an estimate", lot.estimated === true);
}

// --- no road: defaults, facing +y ---
{
  const lot = deriveLot({ house, site: null });
  check("with no map the front is +y", lot.front.side === "+y");
  check("and the setbacks are the defaults", lot.setbacks.front === 7.5 && lot.setbacks.rear === 9 && lot.setbacks.left === 3);
  check("no kerb without a road", lot.front.kerb === null);
}

// --- a neighbour halves the gap ---
{
  const neighbour = { outline: [[20, 0], [28, 0], [28, 8], [20, 8]] as Vec2[], kind: null, heightM: 6 };
  const lot = deriveLot({ house, site: site([street("Maple Street", "residential", [[[-40, -12], [50, -12]]])], [neighbour]) });
  // The gap is 10m; the lot line is halfway.
  check("a neighbour across a side puts the lot line halfway", Math.abs(Math.max(...xs(lot.polygon)) - 15) < 0.01, `${Math.max(...xs(lot.polygon))}`);
  const diagonal = { outline: [[30, 30], [38, 30], [38, 38], [30, 38]] as Vec2[], kind: null, heightM: 6 };
  const lot2 = deriveLot({ house, site: site([], [diagonal]) });
  check("a building off the corner is not across any side", Math.abs(Math.max(...xs(lot2.polygon)) - 13) < 0.01);
}

// --- the house's own garage is on the lot, not across the fence ---
{
  const garage = { outline: [[11.5, 1], [14.5, 1], [14.5, 7], [11.5, 7]] as Vec2[], kind: "garage", heightM: 2.8 };
  const neighbour = { outline: [[16, -2], [24, -2], [24, 8], [16, 8]] as Vec2[], kind: null, heightM: 5 };
  const lot = deriveLot({ house, site: site([street("Maple Street", "residential", [[[-40, -12], [50, -12]]])], [garage, neighbour]) });
  const right = Math.max(...xs(lot.polygon));
  check("a garage beside the house does not shrink the lot to exclude itself", right > 14.5, `${right}`);
  check("the lot reaches past the garage", pointInPolygon([13, 4], lot.polygon));
  check("but not into the neighbour", right < 16, `${right}`);
}

// --- the map's garage on the lot decides the drive's side ---
{
  // The garage stands west of the house (the viewer's right from the street),
  // and the read's bearing says nothing.
  const garage = { outline: [[-4.5, 1], [-1.5, 1], [-1.5, 7], [-4.5, 7]] as Vec2[], kind: "garage", heightM: 2.8 };
  const lot = deriveLot({ house, site: site([street("Maple Street", "residential", [[[-40, -12], [50, -12]]])], [garage]) });
  check("the drive goes to the map's garage", lot.drivewaySide === "right", lot.drivewaySide);
}

// --- a road behind, nearer than the rear setback, cuts it ---
{
  const lot = deriveLot({
    house,
    site: site([
      street("Maple Street", "residential", [[[-40, -12], [50, -12]]]),
      street("Back Lane", "living_street", [[[-40, 14], [50, 14]]]),
    ]),
  });
  // 6m to the lane's centreline, 5.5m wide, 1.5m verge: 1.75m.
  check("a road behind cuts the rear setback", Math.abs(lot.setbacks.rear - 1.75) < 0.01, `${lot.setbacks.rear}`);
  check("the front is still the nearer road", lot.front.street === "Maple Street");
}

// --- a road at an angle: the lawn stays off the asphalt ---
{
  // A road running at 20 degrees, passing about 12m in front of the house.
  const t = Math.tan((20 * Math.PI) / 180);
  const way: Vec2[] = [[-40, -12 - 45 * t], [50, -12 + 45 * t]];
  const lot = deriveLot({ house, site: site([street("Angle Road", "residential", [way])]) });
  check("an angled road still fronts the house", lot.front.side === "-y", lot.front.side);
  check("the lot is still a sensible polygon", lot.polygon.length >= 4 && Math.abs(signedArea(lot.polygon)) > 100);
  check("and contains the house", containsHouse(lot.polygon));
  // No lot vertex on the road side of the road's edge (3.5m + 0.3m from the centreline).
  const [a, b] = way;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const onRoad = lot.polygon.filter((p) => {
    const cross = (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / len;
    // The house is on the +cross side; anything within 3.8m of the line is on the road.
    return cross < 3.8 - 1e-6;
  });
  check("no corner of the lawn lies on the road", onRoad.length === 0, onRoad.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" | "));
}

// --- the door and the drive follow the bearings ---
{
  const s = site([street("Maple Street", "residential", [[[-40, -12], [50, -12]]])]);
  // Plan +x is east (90). A door bearing of 350 leaves through the -y (north)
  // wall, west of centre.
  const lot = deriveLot({ house, site: s, frontDoorBearing: 350, planXBearing: 90 });
  check("the door is on the front wall", lot.frontDoor[1] === 0);
  check("and west of centre for a bearing west of north", lot.frontDoor[0] < 5, `${lot.frontDoor[0].toFixed(2)}`);
  // A visitor stands opposite the door, not opposite the middle of the house.
  check("the kerb is opposite the door", lot.front.kerb !== null && Math.abs(lot.front.kerb![0] - lot.frontDoor[0]) < 0.01, `${lot.front.kerb} vs ${lot.frontDoor}`);
  check("on the near edge of the road", lot.front.kerb !== null && Math.abs(lot.front.kerb![1] - -8.5) < 0.01);
  // A garage to the east: facing the house from the street (looking south),
  // east is on your left.
  const east = deriveLot({ house, site: s, garageBearing: 90, planXBearing: 90 });
  check("a garage to the east puts the drive on the viewer's left", east.drivewaySide === "left", east.drivewaySide);
  const west = deriveLot({ house, site: s, garageBearing: 270, planXBearing: 90 });
  check("and to the west on the right", west.drivewaySide === "right", west.drivewaySide);
}

// --- the door steps aside from a window at the wall's middle ---
{
  const s = site([street("Maple Street", "residential", [[[-40, -12], [50, -12]]])]);
  const lot = deriveLot({ house, site: s, windows: [{ center: [5, 0], width: 1.4 }] });
  check("the door steps off a window at the wall's middle", Math.abs(lot.frontDoor[0] - 5) >= 1.4, `${lot.frontDoor[0]}`);
  check("but stays on the front wall", lot.frontDoor[0] > 0.5 && lot.frontDoor[0] < 9.5 && lot.frontDoor[1] === 0);
  check("and the kerb follows it", lot.front.kerb !== null && Math.abs(lot.front.kerb![0] - lot.frontDoor[0]) < 0.01);
  const plain = deriveLot({ house, site: s });
  check("with no window in the way the door stays mid-wall", Math.abs(plain.frontDoor[0] - 5) < 0.01);
}

// --- determinism ---
{
  const s = site([street("Maple Street", "residential", [[[-40, -12], [50, -12]]])]);
  const a = JSON.stringify(deriveLot({ house, site: s }));
  const b = JSON.stringify(deriveLot({ house, site: s }));
  check("the same input gives the same lot", a === b);
}

console.log(
  failures === 0
    ? "LOT OK - the nearest road is the front, neighbours and a second road shorten the sides, an angled road keeps the lawn off the asphalt, and the door and drive follow their bearings"
    : `LOT BROKEN - ${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
