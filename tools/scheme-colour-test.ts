/**
 * A scheme changes the whole house, furniture included.
 *
 * This exists because the browser test could not settle it. Sampling rendered
 * pixels over a bed compared near-white bedding against near-white bedding -
 * the two schemes genuinely differ there by about three values out of 255,
 * which is a real change and not a measurable one. The claim is about the
 * mapping, so the mapping is what gets asserted.
 *
 * The failure it guards against is a scheme that repaints the walls and leaves
 * the sofa the colour it was. That is a paint job rather than a direction, and
 * it is what the first version of this actually did.
 */
import { FURNITURE_COLOURS } from "../src/lib/model/materials";
import { rectangle } from "../src/lib/plan/geometry";
import { DEFAULT_SCHEME, SCHEMES, floorToneFor, recolour, schemeByName } from "../src/lib/model/schemes";
import { furnishRoom } from "../src/lib/model/furniture";

import type { Plan } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

check("there are several directions to choose from", SCHEMES.length >= 4, `${SCHEMES.length}`);

// Every default furniture colour must have a home in every scheme, or a piece
// keeps its old colour and the house comes out half-redecorated.
for (const scheme of SCHEMES) {
  for (const [key, value] of Object.entries(FURNITURE_COLOURS)) {
    const mapped = recolour(value, scheme);
    check(
      `${scheme.name}: ${key} is re-toned`,
      mapped === scheme.furniture[key as keyof typeof scheme.furniture],
      `got ${mapped}`,
    );
  }
}

// Anything the generator invents that is not in the palette must pass through
// untouched rather than being snapped to something arbitrary.
check("an unknown colour is left alone", recolour("#123456", SCHEMES[0]) === "#123456");

// The schemes must actually differ from each other - four names for one palette
// would pass every check above.
for (let i = 0; i < SCHEMES.length; i++) {
  for (let j = i + 1; j < SCHEMES.length; j++) {
    const a = SCHEMES[i];
    const b = SCHEMES[j];
    const same =
      a.wall === b.wall && a.floors.wood === b.floors.wood && a.furniture.timber === b.furniture.timber;
    check(`${a.name} and ${b.name} are different directions`, !same);
  }
}

// And a real furnished room must come out re-toned end to end.
const plan: Plan = {
  scaleRef: { px: 1, meters: 1 },
  rooms: [
    { id: "r1", label: "Bedroom", polygon: rectangle(0, 0, 4, 4), ceilingHeight: 2.7, level: 0 },
  ],
  openings: [],
};
const boxes = furnishRoom(plan, plan.rooms[0]).flatMap((piece) => piece.boxes);
check("the test room is actually furnished", boxes.length > 0, `${boxes.length} boxes`);

for (const scheme of SCHEMES) {
  const palette = new Set(Object.values(scheme.furniture));
  const strays = boxes
    .map((box) => recolour(box.colour, scheme))
    .filter((colour) => !palette.has(colour));
  check(`${scheme.name}: a furnished bedroom is entirely in-scheme`, strays.length === 0,
    `${strays.length} boxes kept another palette's colour`);
}

// Floors follow the room's kind, and the tone follows the scheme.
const warm = schemeByName("Warm traditional");
const cool = schemeByName("Cool contemporary");
check("a bedroom is carpeted in both", floorToneFor("Bedroom", warm) === warm.floors.carpet);
check("the tone differs between schemes",
  floorToneFor("Living Room", warm) !== floorToneFor("Living Room", cool),
  `${floorToneFor("Living Room", warm)} and ${floorToneFor("Living Room", cool)}`);
check("an unknown scheme name falls back rather than throwing",
  schemeByName("nonsense").name === DEFAULT_SCHEME.name);

// An unread wood floor must not default to grey. It did: the old default's
// "wood" was #9b9691, and with the photographs now read the scheme only ever
// fills the rooms nobody photographed - which is no reason to make them cold.
{
  const hex = DEFAULT_SCHEME.floors.wood;
  const r = parseInt(hex.slice(1, 3), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  check("the default scheme's wood floor is warm", r > b + 20, `${hex}`);
}

console.log(
  failures === 0
    ? `SCHEME COLOUR OK - ${SCHEMES.length} directions, each re-toning every surface and every piece of furniture`
    : `SCHEME COLOUR BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
