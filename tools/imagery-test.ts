/**
 * The arithmetic that makes a satellite tile measurable.
 *
 * Every number here is one a picture cannot check. A frame at the wrong zoom
 * still looks like a house; an outline projected with the wrong sign still
 * overlays something. The failures are silent, so they are pinned here.
 */
import {
  TILE_MARGIN,
  bearingBetween,
  fovForBuilding,
  metresBetween,
  metresPerPixel,
  zoomForExtent,
} from "../src/lib/site/geo";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) < tol;

// --- Bearings, against directions anyone can check by hand ---
const here = { lat: 47.6, lon: -122.3 };
check("due north is 0", near(bearingBetween(here, { lat: 47.61, lon: -122.3 }), 0, 0.5));
check("due east is 90", near(bearingBetween(here, { lat: 47.6, lon: -122.28 }), 90, 0.5));
check("due south is 180", near(bearingBetween(here, { lat: 47.59, lon: -122.3 }), 180, 0.5));
check("due west is 270", near(bearingBetween(here, { lat: 47.6, lon: -122.32 }), 270, 0.5));
check(
  "a bearing is never negative",
  bearingBetween(here, { lat: 47.6, lon: -122.31 }) > 0,
  `${bearingBetween(here, { lat: 47.6, lon: -122.31 })}`,
);

// A tenth of a degree of latitude is about 11.1km, everywhere.
check(
  "distance is metric",
  near(metresBetween(here, { lat: 47.7, lon: -122.3 }), 11_132, 40),
  `${metresBetween(here, { lat: 47.7, lon: -122.3 })}`,
);
// Longitude shrinks with latitude - a degree at 47.6N is about 75km, not 111km.
check(
  "longitude is scaled by latitude",
  near(metresBetween(here, { lat: 47.6, lon: -121.3 }), 75_050, 400),
  `${metresBetween(here, { lat: 47.6, lon: -121.3 })}`,
);

// --- Ground resolution: Web Mercator's own numbers ---
// At the equator, zoom 0 is 156543.03392 m/px over 256px.
check(
  "equator zoom 0 at scale 1",
  near(metresPerPixel(0, 0, 1), 156_543.03392, 0.001),
  `${metresPerPixel(0, 0, 1)}`,
);
check(
  "each zoom level halves the ground per pixel",
  near(metresPerPixel(0, 10, 1), metresPerPixel(0, 9, 1) / 2, 1e-9),
);
check(
  "scale=2 halves the ground per pixel without changing coverage",
  near(metresPerPixel(47.6, 20, 2), metresPerPixel(47.6, 20, 1) / 2, 1e-9),
);
// The worked case: 47.6N at zoom 21, scale 2.
check(
  "a real tile resolves at about 5cm per pixel",
  near(metresPerPixel(47.6, 21, 2), 0.0252, 0.001),
  `${metresPerPixel(47.6, 21, 2)}`,
);

// --- Zoom choice: the building fills the frame, and never overruns it ---
//
// One integer step of slack beyond the intended margin, because zoom is
// integral: the ideal is rounded down, so the frame can be up to twice as wide
// as wanted and never narrower than the building.
const TILE_MARGIN_LIMIT = TILE_MARGIN * 2;

for (const [lat, extent] of [[47.6, 15], [47.6, 30], [25, 12], [61, 22], [-33, 18]] as const) {
  const zoom = zoomForExtent(lat, extent);
  // Coverage depends on the logical 640px, not on scale.
  const coverage = 640 * metresPerPixel(lat, zoom, 1);
  check(
    `zoom ${zoom} still contains a ${extent}m building at ${lat}deg`,
    coverage >= extent,
    `covers ${coverage.toFixed(1)}m`,
  );
  // Only when the zoom was free to choose. A small building at high latitude
  // hits the cap at 21 and simply cannot fill the frame - going further would
  // mean asking for a zoom Google answers by upsampling, which looks sharper
  // and carries no more detail.
  if (zoom < 21) {
    check(
      `zoom ${zoom} does not waste the frame at ${lat}deg`,
      coverage <= extent * TILE_MARGIN_LIMIT,
      `covers ${coverage.toFixed(1)}m for ${extent}m`,
    );
  }
  check(`zoom stays in range at ${lat}deg`, zoom >= 17 && zoom <= 21, `${zoom}`);
}
// --- Degenerate input does not produce a broken request ---
check("a zero-extent building still gets a zoom", zoomForExtent(47.6, 0) >= 17);
check("an absurd extent clamps rather than underflowing", zoomForExtent(47.6, 1e6) === 17);
check("a tiny building clamps at the top rather than upsampling", zoomForExtent(47.6, 2) === 21);

// --- Field of view frames the house, not the street ---
check("a house across the road is framed tightly", fovForBuilding(12, 20) < 90, `${fovForBuilding(12, 20)}`);
check("a house on the pavement needs a wide shot", fovForBuilding(18, 6) > 90, `${fovForBuilding(18, 6)}`);
check("the field of view never leaves the legal range",
  [fovForBuilding(1, 200), fovForBuilding(60, 3), fovForBuilding(0, 0)].every((f) => f >= 10 && f <= 120));

console.log(
  failures === 0
    ? "IMAGERY OK - bearings, Web Mercator resolution and framing all check out"
    : `IMAGERY BROKEN - ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
