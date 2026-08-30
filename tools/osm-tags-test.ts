/**
 * Reading what a mapper already recorded about the outside of a building.
 *
 * These tags were being fetched and discarded on every single lookup. They are
 * survey data under a licence the app already complies with, so anything read
 * here is something a model does not have to guess at from a photograph.
 *
 * The failure mode this guards against is not a crash - it is quietly inventing
 * an exterior for a building that has none tagged, which would then be shown
 * with the same confidence as one that does.
 */
import { exteriorFromOsm, mergeExterior } from "../src/lib/site/osm";
import type { Exterior } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

// --- A well-tagged building ---
const full = exteriorFromOsm({
  tags: {
    building: "house",
    "building:levels": "2",
    "roof:shape": "gabled",
    "roof:direction": "90",
    "roof:material": "roof_tiles",
    "roof:colour": "#8b3a2f",
    "building:material": "brick",
    "building:colour": "cream",
  },
  outbuildings: [{ bearing: 270, kind: "garage" }],
});

check("a tagged building is read", full !== null);
check("storeys come from building:levels", full?.storeys === 2, `${full?.storeys}`);
check("OSM's 'gabled' maps to our 'gable'", full?.roof?.shape === "gable", `${full?.roof?.shape}`);
check("the ridge bearing is numeric", full?.roof?.ridgeBearing === 90, `${full?.roof?.ridgeBearing}`);
check("a hex roof colour survives", full?.roof?.colour === "#8b3a2f", `${full?.roof?.colour}`);
check("a named wall colour survives", full?.walls?.colour === "cream", `${full?.walls?.colour}`);
check("the wall material is read", full?.walls?.material === "brick");
check("the garage keeps its bearing", full?.garage?.bearing === 270, `${full?.garage?.bearing}`);
check("survey data is marked as such", full?.source === "map" && full?.confidence === "high");

// --- The ordinary case: a building with nothing but `building=house` ---
const bare = exteriorFromOsm({ tags: { building: "house" }, outbuildings: [] });
check("an untagged building reads as nothing, not as an empty exterior", bare === null);

// --- Partial tagging is normal and must not be all-or-nothing ---
const partial = exteriorFromOsm({ tags: { building: "house", "roof:shape": "hipped" } });
check("one tag is enough to be worth returning", partial !== null);
check("a hipped roof maps to hip", partial?.roof?.shape === "hip");
check("what was not tagged stays null", partial?.storeys === null && partial?.walls === null);

// --- Compass points, which mappers write instead of degrees ---
const compass = exteriorFromOsm({ tags: { building: "house", "roof:direction": "SW" } });
check("a compass point is read as a bearing", compass?.roof?.ridgeBearing === 225, `${compass?.roof?.ridgeBearing}`);

// --- Junk is dropped rather than passed on ---
const junk = exteriorFromOsm({
  tags: { building: "house", "roof:colour": "brownish red", "building:levels": "0" },
});
check("a freehand colour is dropped", junk === null || junk.roof?.colour === null, JSON.stringify(junk?.roof));
check("a zero storey count is dropped", junk === null || junk.storeys === null, `${junk?.storeys}`);

// --- Outbuildings that are not garages do not become one ---
const shed = exteriorFromOsm({
  tags: { building: "house", "building:levels": "1" },
  outbuildings: [{ bearing: 10, kind: "shed" }],
});
check("a shed is not a garage", shed?.garage === null, JSON.stringify(shed?.garage));

// --- Merging: the map wins, the reading fills gaps ---
const read: Exterior = {
  storeys: 3,
  roof: { shape: "flat", ridgeBearing: null, pitchDeg: 25, material: null, colour: null },
  walls: { material: "stucco", colour: "white" },
  frontDoorBearing: 180,
  garage: null,
  source: "imagery",
  imageryDate: "2019-07",
  confidence: "low",
  attribution: ["© Google"],
};

const merged = mergeExterior(full, read);
check("a surveyed storey count beats a read one", merged?.storeys === 2, `${merged?.storeys}`);
check("a surveyed roof shape beats a read one", merged?.roof?.shape === "gable", `${merged?.roof?.shape}`);
check("the reading fills what the map left out", merged?.roof?.pitchDeg === 25, `${merged?.roof?.pitchDeg}`);
check("the reading supplies the front door", merged?.frontDoorBearing === 180);
check("the merged source says both", merged?.source === "both");
check("a low-confidence reading drags the merge down", merged?.confidence === "low");
check("the imagery date is carried", merged?.imageryDate === "2019-07");
check("both attributions are kept", (merged?.attribution ?? []).includes("© Google"));

// --- Merging with nothing on either side ---
check("map only", mergeExterior(full, null)?.storeys === 2);
check("reading only", mergeExterior(null, read)?.storeys === 3);
check("neither", mergeExterior(null, null) === null);

console.log(
  failures === 0
    ? "OSM TAGS OK - surveyed exteriors are read, junk is dropped, and the map beats the picture"
    : `OSM TAGS BROKEN - ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
