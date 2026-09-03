/** A box's material comes from what it says, then its finish, then its kind. */
import { materialForBox } from "../src/lib/model/box-material";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

check("a sofa is fabric", materialForBox("sofa", {}) === "fabric");
check("a wardrobe is wood", materialForBox("wardrobe", {}) === "wood");
check("a counter is painted wood", materialForBox("counter", {}) === "paintedWood");
check("a range is steel", materialForBox("range", {}) === "metal");
check("a fireplace is stone", materialForBox("fireplace", {}) === "stone");
check("a stainless worktop is steel by its finish", materialForBox("counter", { finish: { roughness: 0.35, metalness: 0.8 } }) === "metal");
check("a stone worktop is stone by its finish", materialForBox("counter", { finish: { roughness: 0.4, metalness: 0 } }) === "stone");
check("a box that says wins", materialForBox("sofa", { material: "leather" }) === "leather");
check("something unknown is paint", materialForBox("whatnot", {}) === "paint");

console.log(failures === 0 ? "BOX MATERIAL OK - said, then finish, then kind" : `BOX MATERIAL BROKEN - ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
