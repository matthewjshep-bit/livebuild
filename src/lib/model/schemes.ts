// The room-to-material mapping lives with the textures and is imported rather
// than repeated. Writing it down twice is the exact bug this codebase has
// already had three times over room names.
import { FURNITURE_COLOURS } from "@/lib/model/materials";
import { type FloorFinish, floorFinish } from "@/lib/model/textures";

/**
 * Interior schemes: a whole direction, not a colour.
 *
 * A single palette makes every house this tool produces look like the same
 * house, which is a strange thing for something whose whole claim is that it
 * builds *your* property. It is also the cheapest way to make the model useful
 * beyond showing what is there: a buyer looking at a dated interior wants to
 * know what it could look like, and that is a question the geometry can already
 * answer.
 *
 * Each scheme names walls, ceiling, trim and a tone per floor material, plus an
 * upholstery palette the furniture draws from - so switching one changes the
 * house together rather than repainting the walls and leaving 1990s oak on the
 * floor.
 */

export type Scheme = {
  name: string;
  blurb: string;
  wall: string;
  wallExterior: string;
  ceiling: string;
  trim: string;
  /** Floor tone per material. The material itself follows the room's kind. */
  floors: Record<FloorFinish, string>;
  furniture: {
    soft: string;
    softDark: string;
    timber: string;
    timberDark: string;
    white: string;
    metal: string;
    dark: string;
    glassy: string;
  };
};

export const SCHEMES: Scheme[] = [
  {
    name: "Warm minimal",
    blurb: "Soft sand walls, pale oak, matte black hardware. Quiet and uncluttered.",
    wall: "#ece7dd",
    wallExterior: "#e2ddd3",
    ceiling: "#faf8f4",
    trim: "#ffffff",
    floors: {
      wood: "#cbb08a",
      tile: "#d8d5cf",
      stone: "#d4d0c7",
      carpet: "#c3b6a3",
      concrete: "#a8a8a6",
      grass: "#9aa88f",
    },
    furniture: {
      soft: "#c3b6a3",
      softDark: "#8f8778",
      timber: "#b39770",
      timberDark: "#8a6a45",
      white: "#f6f4f0",
      metal: "#5a5750",
      dark: "#3c3c3e",
      glassy: "#dbe3e6",
    },
  },
  {
    name: "Cool contemporary",
    blurb: "Crisp white walls, grey wide-plank floors, steel and glass. The default new-build look.",
    wall: "#f2f1ee",
    wallExterior: "#e8e6e1",
    ceiling: "#fafafa",
    trim: "#ffffff",
    floors: {
      wood: "#9b9691",
      tile: "#dcdedd",
      stone: "#cfd2d3",
      carpet: "#b4b7bb",
      concrete: "#a8a8a6",
      grass: "#9aa88f",
    },
    furniture: {
      soft: "#b9bcc4",
      softDark: "#8e929c",
      timber: "#a9865c",
      timberDark: "#8a6a45",
      white: "#f4f4f2",
      metal: "#c2c6cb",
      dark: "#4d5560",
      glassy: "#cfe0ea",
    },
  },
  {
    name: "Warm traditional",
    blurb: "Cream walls, red-oak floors, painted trim and walnut joinery.",
    wall: "#f0e9db",
    wallExterior: "#e6dccb",
    ceiling: "#fbf7ef",
    trim: "#fdfcf8",
    floors: {
      wood: "#a8714a",
      tile: "#d6cfc2",
      stone: "#cfc7b6",
      carpet: "#b9a68b",
      concrete: "#a8a49c",
      grass: "#93a288",
    },
    furniture: {
      soft: "#9a7f63",
      softDark: "#6f5c47",
      timber: "#8a5a35",
      timberDark: "#6a4426",
      white: "#f6f1e6",
      metal: "#c9a24b",
      dark: "#4a3a2c",
      glassy: "#d8dfe0",
    },
  },
  {
    name: "Coastal",
    blurb: "Chalky cool white, bleached timber, linen and muted blue.",
    wall: "#eef0ef",
    wallExterior: "#e4e8e8",
    ceiling: "#fbfcfc",
    trim: "#ffffff",
    floors: {
      wood: "#d9cdba",
      tile: "#dde2e2",
      stone: "#d2d8d8",
      carpet: "#c6cbc9",
      concrete: "#adb2b2",
      grass: "#9fae95",
    },
    furniture: {
      soft: "#c9d2d4",
      softDark: "#93a3a9",
      timber: "#c2ab8c",
      timberDark: "#94795a",
      white: "#fbfcfc",
      metal: "#9fa9ad",
      dark: "#5d7080",
      glassy: "#cfe0ea",
    },
  },
];

/**
 * Warm by default.
 *
 * The default was "Cool contemporary", whose "wood" floor is `#9b9691` - a
 * grey. With the photographs now read, the scheme only ever fills the rooms
 * nobody photographed, and an unread wood floor should not come out grey.
 */
export const DEFAULT_SCHEME = SCHEMES[0];

/** The name given to a scheme derived from the building's own colours. */
export const THIS_HOUSE = "This house";

/**
 * A CSS colour name or hex to `#rrggbb`, or null if it is neither.
 *
 * Deliberately a short list rather than the full CSS set: these are the words
 * OpenStreetMap mappers and a vision model actually use for a building, and a
 * complete table would be a hundred lines of colours no house is painted.
 */
const NAMED: Record<string, string> = {
  white: "#f2f0eb", offwhite: "#eeeae2", cream: "#efe6d2", beige: "#e4d9c3",
  ivory: "#f2ece0", grey: "#9c9c9c", gray: "#9c9c9c", lightgrey: "#c8c8c6",
  lightgray: "#c8c8c6", darkgrey: "#5c5c5c", darkgray: "#5c5c5c",
  silver: "#c0c0c0", black: "#2b2b2b", charcoal: "#3c3f42", brown: "#7a5c42",
  tan: "#c9a882", sand: "#ddc9a3", red: "#9e3b30", brick: "#8b4a3a",
  terracotta: "#a85c3f", orange: "#c17a45", yellow: "#d9c06a", cream_yellow: "#e8dba6",
  green: "#5c7355", olive: "#6f7350", sage: "#9aa88f", blue: "#4a6b8a",
  lightblue: "#a8c0d4", navy: "#33455c", slate: "#5a6672", stone: "#b8b2a5",
};

export function toHex(colour: string | null | undefined): string | null {
  if (!colour) return null;
  const value = colour.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  if (/^#[0-9a-f]{3}$/.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  return NAMED[value.replace(/[^a-z]/g, "")] ?? null;
}

/**
 * A scheme wearing this building's own colours.
 *
 * Derived by *tinting a copy* of an existing scheme rather than built from the
 * two colours we know, and that is not laziness. A `Scheme` owes a tone for
 * every floor finish and a whole upholstery palette that `recolour` matches by
 * exact string; a scheme assembled from a wall colour and a roof colour would
 * have holes in both, and the holes show up as untextured floors and furniture
 * that ignores the scheme entirely.
 *
 * Only the exterior is repainted from what was observed. The reading is of the
 * *outside* of the house - satellite and street level see nothing else - and
 * painting the interior brick red because the walls are brick would be
 * asserting something nobody looked at.
 */
export function houseScheme(exterior: {
  walls?: { colour?: string | null } | null;
  roof?: { colour?: string | null } | null;
} | null | undefined): Scheme | null {
  const wall = toHex(exterior?.walls?.colour);
  const roof = toHex(exterior?.roof?.colour);
  if (!wall && !roof) return null;

  const base = DEFAULT_SCHEME;
  return {
    ...base,
    name: THIS_HOUSE,
    blurb: wall
      ? "The colours read off the building itself, inside left as it is."
      : "The roof read off the building itself.",
    wallExterior: wall ?? base.wallExterior,
    floors: { ...base.floors },
    furniture: { ...base.furniture },
  };
}

/**
 * The schemes on offer for one property.
 *
 * `SCHEMES` is a module constant that several places index by name, so a
 * house-specific entry is prepended to a copy rather than pushed into it -
 * mutating the shared array would give every other property in the tab this
 * one's colours.
 */
export function schemesFor(exterior: Parameters<typeof houseScheme>[0]): Scheme[] {
  const own = houseScheme(exterior);
  return own ? [own, ...SCHEMES] : SCHEMES;
}

export function schemeByName(name: string | null | undefined, from: Scheme[] = SCHEMES): Scheme {
  return from.find((s) => s.name === name) ?? from.find((s) => s.name === DEFAULT_SCHEME.name) ?? from[0];
}

/** A room's floor colour under a given scheme. */
export function floorToneFor(label: string, scheme: Scheme): string {
  return scheme.floors[floorFinish(label)];
}

/**
 * Re-tone a furniture colour into the current scheme.
 *
 * The generator writes the default palette into every box it makes, and
 * threading a scheme through forty call sites would churn a file that is about
 * shapes, not colours. Translating at the point the boxes are consumed keeps
 * the two concerns apart - and it is what stops a scheme repainting the walls
 * while leaving the sofa the colour it was, which is the specific failure that
 * makes a "whole direction" not one.
 */
export function recolour(colour: string, scheme: Scheme): string {
  const key = (Object.keys(FURNITURE_COLOURS) as Array<keyof typeof FURNITURE_COLOURS>).find(
    (k) => FURNITURE_COLOURS[k] === colour,
  );
  return key ? scheme.furniture[key] : colour;
}
