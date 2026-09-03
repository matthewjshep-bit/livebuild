/**
 * The garden goes where a garden goes.
 *
 * Each rule on its own: the path reaches the street from the door, the drive
 * runs from the street past the house to the garage, nothing is planted on
 * the house or the hardstanding, the fence stays off the front unless the
 * read said it ran along the street, and a read with nothing in it plants
 * nothing.
 */
import { landscapeFor } from "../src/lib/model/landscape";
import { deriveLot } from "../src/lib/site/lot";
import { pointInPolygon } from "../src/lib/plan/geometry";
import type { PlanSite } from "../src/lib/site/plan-site";
import type { LandscapeFeature } from "../src/lib/spec/schema";
import type { Vec2 } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

// A 10 by 8 house with Maple Street along y = -12 in front of its -y side.
const house = { x0: 0, y0: 0, x1: 10, y1: 8 };
const site: PlanSite = { streets: [{ name: "Maple Street", kind: "residential", ways: [[[-40, -12], [50, -12]]] }], buildings: [], attribution: [] };
const lot = deriveLot({ house, site, garageBearing: 90, planXBearing: 90 });
const f = (id: string, kind: LandscapeFeature["kind"], extra: Partial<LandscapeFeature> = {}): LandscapeFeature => ({
  id, kind, material: null, colour: null, side: null, alongStreet: false, size: null, ...extra,
});
const inside = (p: Vec2) => pointInPolygon(p, lot.polygon);
const onHouse = (p: Vec2, r = 0) => p[0] > house.x0 - r && p[0] < house.x1 + r && p[1] > house.y0 - r && p[1] < house.y1 + r;

// --- nothing read: door, path, drive ---
{
  const g = landscapeFor({ lot, house, features: [], outbuildings: [] });
  // On the front wall (y = 0), standing proud of the siding skin.
  check("a door on the front wall", g.door !== null && Math.abs(g.door!.center[2] + 0.26) < 0.01, `${g.door?.center}`);
  check("a path from the door to the street", g.path !== null && Math.min(...g.path!.map((p) => p[1])) <= Math.min(...lot.polygon.map((p) => p[1])) + 1e-6);
  check("the path is inside the lot", g.path!.every((p) => inside([p[0], Math.max(p[1], Math.min(...lot.polygon.map((q) => q[1])) + 0.01)])));
  check("a drive on the garage's side (east, the viewer's left)", g.driveway !== null && g.driveway!.polygon.every((p) => p[0] > 10), JSON.stringify(g.driveway?.polygon));
  check("the drive meets the front edge", g.driveway!.polygon.some((p) => Math.abs(p[1] - Math.min(...lot.polygon.map((q) => q[1]))) < 1e-6));
  check("and nothing else is planted", g.trees.length === 0 && g.shrubs.length === 0 && g.fence.length === 0 && g.porch.length === 0 && g.outbuildings.length === 0);
}

// --- a read garden ---
{
  const features = [
    f("t1", "tree", { side: "left", size: "l" }),
    f("t2", "tree", { side: "right", size: "s", material: "pine" }),
    f("t3", "tree", { side: "front", size: "m" }),
    f("t4", "tree", { alongStreet: true }),
    f("fe", "fence", { colour: "#ffffff" }),
    f("po", "porch"),
    f("dr", "driveway", { material: "asphalt" }),
    f("sh", "shrub"),
    f("he", "hedge"),
    ...Array.from({ length: 9 }, (_, i) => f(`tb${i}`, "tree", { side: "back" })),
  ];
  const g = landscapeFor({ lot, house, features, outbuildings: [] });
  check("every tree is on the lot", g.trees.every((t) => inside(t.at)), g.trees.map((t) => t.at.map((v) => v.toFixed(1)).join(",")).join(" | "));
  check("no tree is on the house", g.trees.every((t) => !onHouse(t.at, 1)));
  check("no tree is on the drive or the path", g.trees.every((t) => !pointInPolygon(t.at, g.driveway!.polygon) && !pointInPolygon(t.at, g.path!)));
  check("thirteen tree features plant at most eight", g.trees.length <= 8 && g.trees.length >= 5, `${g.trees.length}`);
  check("a pine is a cone", g.trees.some((t) => t.shape === "cone"));
  check("a large tree is taller than a small one", Math.max(...g.trees.map((t) => t.heightM)) > Math.min(...g.trees.map((t) => t.heightM)));
  const street = g.trees.find((t) => t.at[1] < -5);
  check("a tree along the street stands by the front edge", street !== undefined, g.trees.map((t) => t.at[1].toFixed(1)).join(","));
  check("the drive is asphalt", g.driveway?.material === "asphalt");
  check("a porch stands at the door", g.porch.length === 1 && g.steps.length === 2);
  check("the fence stays off the front", g.fence.length > 0 && g.fence.every((r) => (r.a[1] + r.b[1]) / 2 > Math.min(...lot.polygon.map((p) => p[1])) + 0.5));
  check("and is white when the read said white", g.fence.every((r) => r.colour === "#ffffff"));
  // The front is -y, so "in front of the wall" is a smaller y.
  check("shrubs flank the door", g.shrubs.length >= 2 && g.shrubs.every((s) => Math.abs(s.at[1] + 0.7) < 0.01), g.shrubs.map((s) => s.at[1]).join(","));
  check("a hedge runs along the front", g.hedges.length >= 1 && g.hedges.every((h) => h.a[1] < 0));
}

// --- a fence along the street, and a garage from the read ---
{
  const g = landscapeFor({ lot, house, features: [f("fe", "fence", { alongStreet: true }), f("ga", "garage")], outbuildings: [] });
  check("a fence along the street runs on the front too", g.fence.some((r) => (r.a[1] + r.b[1]) / 2 < Math.min(...lot.polygon.map((p) => p[1])) + 0.5));
  check("a read garage is built on the lot", g.outbuildings.length === 1 && g.outbuildings[0].kind === "garage");
  // The side strip is three metres, so the garage goes behind the house,
  // reaching the drive's side; the drive runs past the house to its front.
  check("reaching the drive's side", g.outbuildings[0].rect.x1 > 10, JSON.stringify(g.outbuildings[0].rect));
  check("behind the house", g.outbuildings[0].rect.y0 >= 8 - 1e-6);
  check("and the drive reaches it", g.driveway !== null && Math.max(...g.driveway!.polygon.map((p) => p[1])) >= g.outbuildings[0].rect.y0 - 1e-6, `${Math.max(...g.driveway!.polygon.map((p) => p[1]))} vs ${g.outbuildings[0].rect.y0}`);
  check("beside the house, not through it", g.driveway!.polygon.every((p) => p[0] >= 10));
}

// --- the map's garage ring beats the read's ---
{
  const ring: Vec2[] = [[12, 2], [15, 2], [15, 8], [12, 8]];
  const lot2 = deriveLot({ house, site: { ...site, buildings: [{ outline: ring, kind: "garage", heightM: 2.8 }] }, garageBearing: 90, planXBearing: 90 });
  const g = landscapeFor({ lot: lot2, house, features: [f("ga", "garage")], outbuildings: [{ outline: ring, kind: "garage" }] });
  check("the map's garage is the garage", g.outbuildings.length === 1 && g.outbuildings[0].rect.x0 === 12);
  check("and the drive is centred on it", g.driveway !== null && Math.abs((g.driveway!.polygon[0][0] + g.driveway!.polygon[1][0]) / 2 - 13.5) < 0.01, JSON.stringify(g.driveway?.polygon));
}

// --- a tree with nowhere on its side goes somewhere, and the door steps off a window ---
{
  const ring: Vec2[] = [[11.5, 0], [14.5, 0], [14.5, 8], [11.5, 8]];
  const lot2 = deriveLot({ house, site: { ...site, buildings: [{ outline: ring, kind: "garage", heightM: 2.8 }] }, planXBearing: 90 });
  const g = landscapeFor({
    lot: lot2, house,
    features: [f("t1", "tree", { side: "left", size: "l" })],
    outbuildings: [{ outline: ring, kind: "garage" }],
  });
  check("a tree the read put where the garage stands is planted elsewhere, not dropped", g.trees.length === 1, `${g.trees.length}`);
  check("and not on the garage", g.trees.every((t) => !(t.at[0] > 10.5 && t.at[0] < 15.5 && t.at[1] > -1 && t.at[1] < 9)), JSON.stringify(g.trees.map((t) => t.at)));
  // The lot decides where the door is - off any window - and the garden
  // takes it as given.
  const lot3 = deriveLot({ house, site: { ...site, buildings: [{ outline: ring, kind: "garage", heightM: 2.8 }] }, planXBearing: 90, windows: [{ center: [5, 0], width: 1.4 }] });
  const g3 = landscapeFor({ lot: lot3, house, features: [], outbuildings: [{ outline: ring, kind: "garage" }] });
  check("the garden's door is the lot's door, off the window", g3.door !== null && Math.abs(g3.door!.center[0] - lot3.frontDoor[0]) < 0.01 && Math.abs(g3.door!.center[0] - 5) >= 1.4, `${g3.door?.center[0]} vs ${lot3.frontDoor[0]}`);
  check("but stays on the front wall", g3.door!.center[0] > 0.5 && g3.door!.center[0] < 9.5);
  // The wall stands outside the polygon to -0.2 and the cladding to -0.22.
  check("proud of the wall and its cladding", g.door!.center[2] - 0.03 < -0.22, `${g.door?.center[2]}`);
  const plain = landscapeFor({ lot: lot2, house, features: [], outbuildings: [] });
  check("with no window in the way the door stays where the lot put it", plain.door !== null && Math.abs(plain.door!.center[0] - 5) < 0.01);
}

// --- determinism ---
{
  const features = [f("t1", "tree", { side: "left" }), f("fe", "fence")];
  const a = JSON.stringify(landscapeFor({ lot, house, features, outbuildings: [] }));
  const b = JSON.stringify(landscapeFor({ lot, house, features, outbuildings: [] }));
  check("the same read plants the same garden", a === b);
}

console.log(
  failures === 0
    ? "LANDSCAPE OK - the path meets the street, the drive reaches the garage, trees stay off the house and the hardstanding, the fence stays off the front unless it runs along the street"
    : `LANDSCAPE BROKEN - ${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
