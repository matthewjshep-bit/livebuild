/**
 * Every bundled set is on disk with its three maps, its licence is CC0 and
 * written down, and every finish the house can name maps to a set.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ASSETS, SKY_ASSET, SKY_PATH, type AssetKey, assetForBox, assetForFloor, assetForRoof, assetForSiding, assetForWall, assetPaths, isBundledUrl,
} from "../src/lib/model/assets";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const PUBLIC = join(process.cwd(), "public");
const keys = Object.keys(ASSETS) as AssetKey[];
let bytes = 0;
for (const key of keys) {
  const asset = ASSETS[key];
  check(`${key} covers some ground`, asset.metresPerTile > 0);
  check(`${key} is CC0`, asset.licence === "CC0");
  const paths = assetPaths(key);
  for (const path of [paths.color, paths.normal, paths.orm]) {
    const file = join(PUBLIC, path);
    const ok = existsSync(file) && statSync(file).size > 1000;
    check(`${path} is shipped`, ok);
    if (ok) bytes += statSync(file).size;
  }
}
check("the studio sky is shipped", existsSync(join(PUBLIC, SKY_PATH)) && statSync(join(PUBLIC, SKY_PATH)).size > 100_000);
check("the whole set stays under twenty megabytes", bytes < 20 * 1024 * 1024, `${(bytes / 1024 / 1024).toFixed(1)} MB`);

const licences = existsSync(join(PUBLIC, "textures", "LICENSES.md")) ? readFileSync(join(PUBLIC, "textures", "LICENSES.md"), "utf8") : "";
check("the licence file exists", licences.length > 0);
for (const key of keys) check(`${key}'s source is credited`, licences.includes(ASSETS[key].source));
check("the sky's source is credited", licences.includes(SKY_ASSET.source));
check("no set is a photograph of a house", /None of these is a photograph of any house/.test(licences));

// Every finish the house can name lands on a set that exists.
for (const f of ["wood", "laminate", "tile", "stone", "carpet", "concrete", "vinyl", null]) check(`floor ${f} has a set`, keys.includes(assetForFloor(f)!));
check("grass stays drawn", assetForFloor("grass") === null);
for (const m of ["paint", "wallpaper", "tile", "panelling", "exposed-brick", "timber", null]) check(`wall ${m} has a set`, keys.includes(assetForWall(m)));
for (const s of ["lap", "shingle", "brick", "stucco", "board-and-batten", null]) check(`siding ${s} has a set`, keys.includes(assetForSiding(s)));
for (const r of ["asphalt shingle", "clay tile", "slate", "standing seam metal", null]) check(`roof ${r} has a set`, keys.includes(assetForRoof(r)));
for (const b of ["fabric", "leather", "wood", "paintedWood", "stone", "paint"] as const) check(`box ${b} has a set`, keys.includes(assetForBox(b)!));
check("steel and glass are not scans", assetForBox("metal") === null && assetForBox("glass") === null);
check("brick walls get the brick", assetForWall("exposed-brick") === "wall-brick" && assetForSiding("brick") === "siding-brick");
check("clay is the tile roof, slate the slate", assetForRoof("clay tiles") === "roof-tile" && assetForRoof("slate") === "roof-slate");

check("a bundled URL is one under /textures/ or /sky/ on this origin",
  isBundledUrl("http://localhost:3000/textures/floor-wood/color.jpg", "http://localhost:3000") &&
  isBundledUrl("http://localhost:3000/sky/studio.hdr", "http://localhost:3000") &&
  !isBundledUrl("http://localhost:3000/properties/demo-house/kitchen.jpg", "http://localhost:3000") &&
  !isBundledUrl("https://cdn.example.com/textures/floor-wood/color.jpg", "http://localhost:3000"));

console.log(failures === 0 ? `ASSETS OK - ${keys.length} CC0 sets on disk, ${(bytes / 1024 / 1024).toFixed(1)} MB, every finish mapped` : `ASSETS BROKEN - ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
