/**
 * What the reader says about the outside is kept safely.
 *
 * The route's answer is plain strings; this is the pure half that folds them
 * into the spec - colours quantised, siding folded to a finish, the garden's
 * one list typed and capped - and the spec's own guarantees around it.
 */
import { reconcileExterior } from "../src/lib/site/exterior-read";
import { inferHouse } from "../src/lib/spec/infer";
import { HouseSpec } from "../src/lib/spec/schema";
import type { Plan } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const parsed = {
  sidingMaterial: "cedar lap siding",
  sidingColour: "#9aa0a3",
  roofShape: "Gable",
  roofMaterial: "asphalt shingle",
  roofColour: "dark grey",
  trimColour: "white",
  doorColour: "",
  contents: [
    { kind: "tree", material: "maple", colour: "", where: "left of the front door", size: "large" },
    { kind: "fence", material: "timber", colour: "white", where: "along the street", size: "" },
    { kind: "shrub", material: "", colour: "#3f5a34", where: "both sides of the steps", size: "small" },
    { kind: "hot tub", material: "", colour: "", where: "behind", size: "" },
    { kind: "Driveway", material: "asphalt", colour: "", where: "right", size: "" },
    ...Array.from({ length: 9 }, (_, i) => ({ kind: "tree", material: "", colour: "", where: "behind", size: "medium" })),
  ],
  confidence: "high" as const,
  notes: "",
};

const read = reconcileExterior(parsed);
check("cedar lap siding folds to lap", read.siding.finish === "lap", `${read.siding.finish}`);
check("and keeps the text", read.siding.material === "cedar lap siding");
check("a hex is quantised", read.siding.colour !== null && /^#[0-9a-f]{6}$/.test(read.siding.colour!), `${read.siding.colour}`);
check("a colour name becomes a hex", read.roof.colour !== null && read.roof.colour!.startsWith("#"), `${read.roof.colour}`);
check("white trim", read.trim.colour !== null, `${read.trim.colour}`);
check("an empty colour is null", read.door.colour === null);
check("the roof shape is folded to the enum", read.roof.shape === "gable", `${read.roof.shape}`);
const kinds = read.features.map((f) => f.kind);
check("a hot tub is dropped, not fatal", !kinds.includes("hot tub" as never));
check("a capitalised kind is fine", kinds.includes("driveway"));
const tree = read.features.find((f) => f.kind === "tree")!;
check("left of the door reads as left", tree.side === "left", `${tree.side}`);
check("large reads as l", tree.size === "l", `${tree.size}`);
const fence = read.features.find((f) => f.kind === "fence")!;
check("along the street is noted", fence.alongStreet === true);
check("white becomes a hex", fence.colour !== null && fence.colour!.startsWith("#"), `${fence.colour}`);
const shrub = read.features.find((f) => f.kind === "shrub")!;
check("both sides reads as both", shrub.side === "both", `${shrub.side}`);
check("ten trees are eight", kinds.filter((k) => k === "tree").length === 8, `${kinds.filter((k) => k === "tree").length}`);

// The spec keeps it, and the inference leaves it alone.
const spec = HouseSpec.parse({
  exterior: {
    siding: { material: read.siding.material, finish: read.siding.finish, colour: read.siding.colour },
    roof: { shape: read.roof.shape, material: read.roof.material, colour: read.roof.colour },
    features: read.features,
    source: { "siding.colour": "read", features: "read" },
    observed: true,
  },
});
check("the spec round-trips", spec.exterior?.observed === true && spec.exterior.features.length === read.features.length);
check("an older spec parses without it", HouseSpec.parse({}).exterior == null);
const plan: Plan = {
  scaleRef: { px: 1, meters: 1 },
  rooms: [{ id: "a", label: "Living Room", polygon: [[0, 0], [6, 0], [6, 5], [0, 5]], ceilingHeight: 2.7, level: 0 }],
  openings: [],
};
const inferred = inferHouse(plan, spec).spec;
check("the inference carries the outside untouched", JSON.stringify(inferred.exterior) === JSON.stringify(spec.exterior));

console.log(
  failures === 0
    ? "EXTERIOR READ OK - siding folds to a finish, colours quantise, the garden's list is typed and capped, and the spec keeps it through the inference"
    : `EXTERIOR READ BROKEN - ${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
