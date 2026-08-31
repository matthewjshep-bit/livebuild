/**
 * A building's outline recovered from a satellite frame.
 *
 * Every failure in this conversion is silent. A mirrored building still tiles
 * into rooms; a transposed one still packs; both look like a badly traced house
 * rather than a coordinate bug, and on a symmetric house they look fine. So the
 * arithmetic is pinned against shapes whose answer is known by construction,
 * and the two classic mistakes - swapping latitude and longitude, and negating
 * the y sign twice - are checked for directly rather than hoped about.
 */
import {
  TRACE_FRAME_PX,
  outlineIsPlausible,
  pixelsToRing,
  ringToPixels,
  syntheticRing,
} from "../src/lib/site/trace";
import { metresPerPixel } from "../src/lib/site/geo";
import { prepareFootprint, rectArea, toLocalMetres } from "../src/lib/plan/footprint";
import { packIntoFootprint } from "../src/lib/plan/footprint";
import { M_PER_FT } from "../src/lib/units";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) < tol;

const CENTRE = { lat: 37.256, lon: -122.0316 };
const MPP = metresPerPixel(CENTRE.lat, 20); // ~0.06 m per file pixel
const HALF = TRACE_FRAME_PX / 2;

// --- A rectangle placed dead centre, in pixels ---
//
// 400 px wide, 200 px tall, centred. At this resolution that is a building
// about 24m x 12m - a large single-storey house.
const centred: Array<[number, number]> = [
  [HALF - 200, HALF - 100],
  [HALF + 200, HALF - 100],
  [HALF + 200, HALF + 100],
  [HALF - 200, HALF + 100],
];
const ring = pixelsToRing(centred, CENTRE, MPP);

check("a ring comes back with one point per pixel", ring.length === 4);
check(
  "the ring is centred on the point that was searched",
  near(ring.reduce((s, p) => s + p[0], 0) / 4, CENTRE.lat, 1e-9) &&
    near(ring.reduce((s, p) => s + p[1], 0) / 4, CENTRE.lon, 1e-9),
);

// Latitude first. A [lon, lat] ring would put ~-122 where a latitude belongs,
// which is the single easiest thing to get wrong and survives everything after.
check(
  "latitude comes first",
  ring.every(([lat, lon]) => Math.abs(lat - CENTRE.lat) < 1 && Math.abs(lon - CENTRE.lon) < 1),
  JSON.stringify(ring[0]),
);

// --- The frame agrees with the projection it will be re-projected through ---
const local = toLocalMetres(ring);
const widthM = Math.max(...local.map((p) => p[0])) - Math.min(...local.map((p) => p[0]));
const depthM = Math.max(...local.map((p) => p[1])) - Math.min(...local.map((p) => p[1]));

check("400 pixels across becomes the right number of metres",
  near(widthM, 400 * MPP, 0.05), `${widthM.toFixed(2)}m vs ${(400 * MPP).toFixed(2)}m`);
check("200 pixels down becomes the right number of metres",
  near(depthM, 200 * MPP, 0.05), `${depthM.toFixed(2)}m vs ${(200 * MPP).toFixed(2)}m`);
check("a wide building stays wider than it is deep", widthM > depthM);

// The y sign, negated exactly once. A pixel ABOVE the centre of the image is
// NORTH of it, which is a HIGHER latitude - and after `toLocalMetres`, whose y
// runs south, it must come back with a LOWER y.
const above = pixelsToRing([[HALF, HALF - 100]], CENTRE, MPP)[0];
const below = pixelsToRing([[HALF, HALF + 100]], CENTRE, MPP)[0];
check("a pixel higher up the image is further north", above[0] > CENTRE.lat, `${above[0]}`);
check("a pixel lower down the image is further south", below[0] < CENTRE.lat, `${below[0]}`);

const projected = toLocalMetres([above, below]);
check(
  "and after projection the northern one has the smaller y, not the larger",
  projected[0][1] < projected[1][1],
  `north y=${projected[0][1].toFixed(2)}, south y=${projected[1][1].toFixed(2)}`,
);

// East is to the right, and stays there.
const right = pixelsToRing([[HALF + 100, HALF]], CENTRE, MPP)[0];
check("a pixel to the right is further east", right[1] > CENTRE.lon);
check("and projects to a positive x", toLocalMetres([right, [CENTRE.lat, CENTRE.lon]])[0][0] > 0);

// --- A building that is not in the middle of the frame ---
//
// The tile is centred on the parcel point, not the house, so an off-centre
// trace has to stay off-centre.
const offset: Array<[number, number]> = centred.map(([u, v]) => [u + 300, v - 150]);
const offsetLocal = toLocalMetres(pixelsToRing([...centred, ...offset], CENTRE, MPP));
const firstMid = offsetLocal.slice(0, 4).reduce((s, p) => s + p[0], 0) / 4;
const secondMid = offsetLocal.slice(4).reduce((s, p) => s + p[0], 0) / 4;
check(
  "a building traced to one side lands to that side",
  near(secondMid - firstMid, 300 * MPP, 0.1),
  `${(secondMid - firstMid).toFixed(2)}m for 300px`,
);

// --- It survives the rest of the pipeline unchanged ---
const footprint = prepareFootprint(ring);
check("a traced ring prepares into rectangles", footprint.rects.length >= 1);
check(
  "at about the area it was traced at",
  near(footprint.areaSqft, (widthM * depthM) / (M_PER_FT * M_PER_FT), 60),
  `${Math.round(footprint.areaSqft)} sqft`,
);

const labels = ["Living Room", "Kitchen", "Bedroom", "Bathroom", "Hallway"];
const rooms = packIntoFootprint(labels, footprint);
const covered = rooms.reduce((sum, r) => {
  const xs = r.polygon.map((p) => p[0]);
  const ys = r.polygon.map((p) => p[1]);
  return sum + (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
}, 0);
const total = footprint.rects.reduce((s, r) => s + rectArea(r), 0);
check("and the rooms fill it exactly", Math.abs(covered - total) < 0.01,
  `${covered.toFixed(2)} of ${total.toFixed(2)}`);
check("with every room placed", rooms.length === labels.length);

// --- The plausibility gate ---
check("a sensible house is accepted", outlineIsPlausible(ring).ok, JSON.stringify(outlineIsPlausible(ring)));

const tooFew = pixelsToRing([[HALF, HALF], [HALF + 100, HALF], [HALF, HALF + 100]], CENTRE, MPP);
check("a triangle is refused", !outlineIsPlausible(tooFew).ok);

// A garden shed: 60px x 60px is about 3.6m x 3.6m.
const shed = pixelsToRing(
  [[HALF, HALF], [HALF + 60, HALF], [HALF + 60, HALF + 60], [HALF, HALF + 60]],
  CENTRE, MPP,
);
const shedWhy = outlineIsPlausible(shed);
check("an outbuilding is refused", !shedWhy.ok, JSON.stringify(shedWhy));
check("and says why", !shedWhy.ok && /outbuilding|sqft/.test(shedWhy.why), JSON.stringify(shedWhy));

// The whole parcel: 1600px x 900px is about 96m x 54m.
const parcel = pixelsToRing(
  [[0, 0], [1600, 0], [1600, 900], [0, 900]], CENTRE, MPP,
);
check("a whole parcel is refused", !outlineIsPlausible(parcel).ok);

// A driveway rather than a house.
const strip = pixelsToRing(
  [[HALF - 400, HALF], [HALF + 400, HALF], [HALF + 400, HALF + 60], [HALF - 400, HALF + 60]],
  CENTRE, MPP,
);
const stripWhy = outlineIsPlausible(strip);
check("something long and thin is refused", !stripWhy.ok, JSON.stringify(stripWhy));

// --- The fallback, when there is nothing to trace ---
const fallback = syntheticRing(CENTRE, 1800);
check("the fallback is a ring of four corners", fallback.length === 4);
const fallbackPrepared = prepareFootprint(fallback);
check(
  "at about the ground-floor area asked for",
  near(fallbackPrepared.areaSqft, 1800, 250),
  `${Math.round(fallbackPrepared.areaSqft)} sqft`,
);

const fbLocal = toLocalMetres(fallback);
const fbW = Math.max(...fbLocal.map((p) => p[0])) - Math.min(...fbLocal.map((p) => p[0]));
const fbD = Math.max(...fbLocal.map((p) => p[1])) - Math.min(...fbLocal.map((p) => p[1]));
check("and shaped like a house rather than a square", fbW / fbD > 1.5, `${(fbW / fbD).toFixed(2)}:1`);
check("the fallback is itself plausible", outlineIsPlausible(fallback).ok);
check("a tiny target still yields a buildable house", outlineIsPlausible(syntheticRing(CENTRE, 50)).ok);

// Drawing the outline back onto the frame is what lets somebody check the
// trace before their floor plan is rearranged around it. A flipped sign draws a
// mirrored house over the right photograph and looks entirely fine, so the
// inverse is pinned against the forward conversion rather than trusted.
{
  const centre = { lat: 37.2431, lon: -122.0308 };
  const mpp = 0.0596;
  const pixels: Array<[number, number]> = [
    [400, 380],
    [900, 380],
    [900, 760],
    [400, 760],
  ];
  const ring = pixelsToRing(pixels, centre, mpp);
  const back = ringToPixels(ring, centre, mpp);

  const worst = Math.max(
    ...back.flatMap((p, i) => [Math.abs(p[0] - pixels[i][0]), Math.abs(p[1] - pixels[i][1])]),
  );
  check("pixels round-trip through lat/lon and back", worst < 0.001, `off by ${worst}px`);
  check("north is up: a lower row is further north", ring[0][0] > ring[2][0]);
  check("east is right: a higher column is further east", ring[1][1] > ring[0][1]);
}

console.log(
  failures === 0
    ? `TRACED FOOTPRINT OK - pixels become a ring in the right frame, it fills exactly, and a shed, a parcel and a driveway are all refused`
    : `TRACED FOOTPRINT BROKEN - ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
