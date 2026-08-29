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

export const DEFAULT_SCHEME = SCHEMES[1];

export function schemeByName(name: string | null | undefined): Scheme {
  return SCHEMES.find((s) => s.name === name) ?? DEFAULT_SCHEME;
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
