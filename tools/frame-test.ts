/**
 * The map and the drawing agree about where the building is.
 *
 * This is the arithmetic most likely to be silently wrong in the whole layout
 * stage. Latitude increases northwards and screen y increases downwards, so a
 * sign error flips the house - and on a roughly symmetrical building a flipped
 * plan looks entirely plausible. Nobody would notice until they tried to draw a
 * kitchen against a satellite image showing the garage.
 *
 * So: round-trip through both directions, and check the transform against the
 * one thing that must already agree with it - the outline `prepareFootprint`
 * produced by walking the same steps internally.
 */
import { prepareFootprint } from "../src/lib/plan/footprint";
import { type OverpassWay, streetsFrom } from "../src/lib/listing/streets";
import { latLonToPlan, planToLatLon, tileExtentFor, tilePlacement } from "../src/lib/site/frame";
import { signedArea } from "../src/lib/plan/geometry";
import type { Vec2 } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

/** A real-ish ring: a 16m x 9m house turned 20 degrees off north. */
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

const LAT = 47.6231;
const LON = -122.2969;

// --- the round trip is exact ---
{
  const fp = prepareFootprint(houseRing(LAT, LON, 20));
  check("a prepared footprint carries its frame", Boolean(fp.frame));
  if (fp.frame) {
    let worst = 0;
    for (const [dLat, dLon] of [[0, 0], [0.0004, 0.0003], [-0.0002, 0.0005], [0.001, -0.001]]) {
      const point = latLonToPlan(fp.frame, LAT + dLat, LON + dLon);
      const [lat, lon] = planToLatLon(fp.frame, point);
      // Compared in metres, because degrees of longitude are not degrees of
      // latitude and an error in one would hide inside the other.
      const off = Math.hypot(
        (lat - (LAT + dLat)) * 111_320,
        (lon - (LON + dLon)) * Math.cos((LAT * Math.PI) / 180) * 111_320,
      );
      worst = Math.max(worst, off);
    }
    check("plan and map round-trip to under a millimetre", worst < 0.001, `${worst.toFixed(6)}m`);
  }
}

// --- the frame agrees with the outline prepareFootprint actually produced ---
//
// The strongest available check, because the outline was made by walking these
// same steps inside the packer. If the frame disagreed by a sign or a rotation,
// the mapped corners would land somewhere else entirely.
for (const turnDeg of [0, 20, 47, -35]) {
  const fp = prepareFootprint(houseRing(LAT, LON, turnDeg));
  if (!fp.frame) {
    check(`frame exists at ${turnDeg}deg`, false);
    continue;
  }
  const mapped = houseRing(LAT, LON, turnDeg).map(([lat, lon]) =>
    latLonToPlan(fp.frame!, lat, lon),
  );

  const bounds = (pts: Vec2[]) => ({
    x0: Math.min(...pts.map((p) => p[0])),
    y0: Math.min(...pts.map((p) => p[1])),
    x1: Math.max(...pts.map((p) => p[0])),
    y1: Math.max(...pts.map((p) => p[1])),
  });
  const a = bounds(mapped);
  const b = bounds(fp.outline);

  // Simplification and the 2ft grid snap move vertices, so this is a metre-scale
  // agreement rather than an exact one. A sign error is tens of metres out.
  const slack = 1.5;
  check(
    `at ${turnDeg}deg the mapped ring lands on the prepared outline`,
    Math.abs(a.x0 - b.x0) < slack &&
      Math.abs(a.y0 - b.y0) < slack &&
      Math.abs(a.x1 - b.x1) < slack &&
      Math.abs(a.y1 - b.y1) < slack,
    `mapped ${JSON.stringify(a)} vs outline ${JSON.stringify(b)}`,
  );
  check(
    `at ${turnDeg}deg the area survives the mapping`,
    Math.abs(Math.abs(signedArea(mapped)) - Math.abs(signedArea(fp.outline))) < 12,
    `${Math.abs(signedArea(mapped)).toFixed(1)} vs ${Math.abs(signedArea(fp.outline)).toFixed(1)}`,
  );
}

// --- the tile is placed where the building is ---
{
  const fp = prepareFootprint(houseRing(LAT, LON, 20));
  if (fp.frame) {
    // Fetched at the frame's own centre, which is the building's centroid -
    // not at the geocoded address point, which can sit at a corner or out on
    // the street. Asking at the wrong point slides the whole picture sideways
    // by however far the two disagree.
    const place = tilePlacement(fp.frame, {
      lat: fp.frame.centre.lat,
      lon: fp.frame.centre.lon,
      sizePx: 1280,
      metresPerPixel: 0.05,
    });
    check("the tile covers its stated ground", Math.abs(place.size - 64) < 1e-9, `${place.size}`);
    // The image's own centre, in the group's coordinates, must be the local
    // point the tile centre projects to - which is what makes the picture line
    // up with the drawing rather than merely sit behind it.
    const centreOfImage: Vec2 = [place.x + place.size / 2, place.y + place.size / 2];
    check(
      "a tile fetched at the frame centre is centred on the building",
      Math.hypot(centreOfImage[0], centreOfImage[1]) < 1e-9,
      JSON.stringify(centreOfImage),
    );

    // And asking at the wrong point is visibly wrong rather than subtly so.
    const offCentre = tilePlacement(fp.frame, {
      lat: LAT, lon: LON, sizePx: 1280, metresPerPixel: 0.05,
    });
    const drift = Math.hypot(
      offCentre.x + offCentre.size / 2,
      offCentre.y + offCentre.size / 2,
    );
    check("asking at a corner instead slides the picture", drift > 5, `${drift.toFixed(2)}m`);
    check("the transform is composed scale, translate, rotate",
      /^scale\(.*\) translate\(.*\) rotate\(.*\)$/.test(place.transform), place.transform);
  }
}

// --- the tile asked for is big enough to draw against ---
{
  const fp = prepareFootprint(houseRing(LAT, LON, 20));
  const extent = tileExtentFor(fp);
  const xs = fp.outline.map((p) => p[0]);
  const span = Math.max(...xs) - Math.min(...xs);
  check("the tile is wider than the house", extent > span, `${extent} vs ${span.toFixed(1)}`);
  check("and never uselessly small", extent >= 30, `${extent}`);
}

// --- a footprint from bare metres has no frame, and that is allowed ---
{
  const fp = prepareFootprint(houseRing(LAT, LON, 0));
  const stripped = { ...fp, frame: undefined };
  check("a frameless footprint is representable", stripped.frame === undefined);
}

// --- a traced outline is never resized, so it stays on its own roof ---
//
// The backdrop is the whole reason. A traced ring is measured in the aerial
// photograph's own pixels and is then drawn back on top of that photograph
// while somebody lays rooms out against the roof they can see. Scaling it to
// agree with a listing's square footage floats the outline inside its own roof,
// which is obviously wrong to look at - and it scales towards the wrong number
// anyway, because a listing states living area and a roof covers more ground.
{
  const ring = houseRing(LAT, LON, 0);
  const unscaled = prepareFootprint(ring, undefined, 9);
  const asMeasured = prepareFootprint(ring, 900, 9, "measured");
  const asTraced = prepareFootprint(ring, 900, 9, "traced");

  check("a measured outline is nudged towards the stated area",
    Math.abs(asMeasured.areaSqft - unscaled.areaSqft) > 1,
    `${asMeasured.areaSqft.toFixed(0)} vs ${unscaled.areaSqft.toFixed(0)}`);
  check("a traced one keeps the size it was traced at",
    Math.abs(asTraced.areaSqft - unscaled.areaSqft) < 1e-6,
    `${asTraced.areaSqft.toFixed(0)} vs ${unscaled.areaSqft.toFixed(0)}`);
  check("and its frame records no scaling", asTraced.frame?.scale === 1,
    `${asTraced.frame?.scale}`);

  // Which is what keeps it registered to the picture it came from.
  if (asTraced.frame) {
    const mapped = ring.map(([lat, lon]) => latLonToPlan(asTraced.frame!, lat, lon));
    const spanX = Math.max(...mapped.map((p) => p[0])) - Math.min(...mapped.map((p) => p[0]));
    check("a 16m house is still 16m after tracing", Math.abs(spanX - 16) < 1.5, `${spanX.toFixed(2)}m`);
  }
}

// --- the streets, which are the reason the frame is plumbed through at all ---
//
// The drawing pad showed the building's outline and nothing about where it sat,
// so "which of these walls faces the road" was not a question it could answer.
// Two things have to hold: only actual named streets survive the fetch, and
// they land on the plan at their true angle to the building.
{
  const ways: OverpassWay[] = [
    { type: "way", tags: { highway: "residential", name: "Maple Street" },
      geometry: [{ lat: LAT + 0.0009, lon: LON - 0.002 }, { lat: LAT + 0.0009, lon: LON }] },
    // The same street, arriving as a second way because it is split at the
    // junction. It must not be labelled twice.
    { type: "way", tags: { highway: "residential", name: "Maple Street" },
      geometry: [{ lat: LAT + 0.0009, lon: LON }, { lat: LAT + 0.0009, lon: LON + 0.002 }] },
    { type: "way", tags: { highway: "tertiary", name: "Oak Avenue" },
      geometry: [{ lat: LAT - 0.001, lon: LON + 0.0012 }, { lat: LAT + 0.001, lon: LON + 0.0012 }] },
    // Everything below is a `highway` and none of it is a street.
    { type: "way", tags: { highway: "service", name: "Rear Access" },
      geometry: [{ lat: LAT, lon: LON }, { lat: LAT, lon: LON + 0.0004 }] },
    { type: "way", tags: { highway: "footway", name: "River Path" },
      geometry: [{ lat: LAT, lon: LON }, { lat: LAT, lon: LON + 0.0004 }] },
    { type: "way", tags: { highway: "residential" },
      geometry: [{ lat: LAT, lon: LON }, { lat: LAT, lon: LON + 0.0004 }] },
    { type: "way", tags: { highway: "residential", name: "Too Short" },
      geometry: [{ lat: LAT, lon: LON }] },
  ];

  const streets = streetsFrom(ways);
  check("only named roads worth drawing survive", streets.length === 2,
    streets.map((x) => x.name).join(", "));
  check("a driveway is not a street", !streets.some((x) => x.name === "Rear Access"));
  check("nor is a footpath", !streets.some((x) => x.name === "River Path"));
  const maple = streets.find((x) => x.name === "Maple Street");
  check("a street split at a junction is one street", maple?.ways.length === 2,
    `${maple?.ways.length}`);

  // And onto the plan. The house is turned 20 degrees off north and the plan is
  // squared up on it, so a street running east-west on the map must come out
  // 20 degrees off the plan's own axis - that angle is the orientation cue.
  const built = prepareFootprint(houseRing(LAT, LON, 20), undefined, 6);
  if (built.frame && maple) {
    const [a, b] = maple.ways[0].map(([lat, lon]) => latLonToPlan(built.frame!, lat, lon));
    const onPlan = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    const off = Math.abs(((onPlan % 90) + 90) % 90);
    check("a street lands on the plan at its true angle to the building",
      Math.min(off, 90 - off) > 15 && Math.min(off, 90 - off) < 25, `${off.toFixed(1)}deg`);

    // North of the house on the map is one side of it on the plan, whichever
    // side that turns out to be - what must not happen is landing inside.
    const inside = built.outline;
    const ys = inside.map((p) => p[1]);
    check("and outside the building it runs past",
      a[1] < Math.min(...ys) || a[1] > Math.max(...ys) ||
        a[0] < Math.min(...inside.map((p) => p[0])) ||
        a[0] > Math.max(...inside.map((p) => p[0])),
      `${a.map((v) => v.toFixed(1))}`);
  }
}

if (failures > 0) {
  console.error(`\nFRAME: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  "FRAME OK - map and plan round-trip to under a millimetre, a mapped ring lands on the outline the packer built at every rotation tried, the tile is placed where the building actually is, and the streets come through named once each and turned to the building",
);
