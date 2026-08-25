import { type RoomKind, roomKind } from "@/lib/plan/room-kind";

/**
 * The palette, in one place.
 *
 * Deliberately architectural rather than photographic: white walls, pale
 * floors, soft greys, no textures and no reflections. A model that tries for
 * realism invites comparison with the actual photographs and loses, whereas one
 * that reads as a considered drawing is judged on its own terms - and stays
 * legible at every zoom, which a textured render does not.
 */

export const PALETTE = {
  wallExterior: "#e8e6e1",
  wallInterior: "#f2f1ee",
  /** Slightly darker so a doorway reads as a recess rather than a flat gap. */
  wallReveal: "#d8d5cf",
  baseboard: "#ffffff",
  ceiling: "#fafafa",
  glass: "#bcd4e6",
  frame: "#ffffff",
} as const;

/** Floor colours by room kind. Warm where a house is warm, cool where it is wet. */
const FLOORS: Record<RoomKind, string> = {
  living: "#c9a875",
  kitchen: "#d8d5cf",
  dining: "#c9a875",
  bedroom: "#b8a894",
  "primary-bedroom": "#b8a894",
  bathroom: "#dcdedd",
  powder: "#dcdedd",
  hallway: "#c4a473",
  stairs: "#c4a473",
  entry: "#d0cdc6",
  office: "#c9a875",
  laundry: "#d8d5cf",
  garage: "#a8a8a6",
  closet: "#b8a894",
  basement: "#9e9e9c",
  outside: "#9aa88f",
  other: "#c4b9a5",
};

export function floorColour(label: string): string {
  return FLOORS[roomKind(label)] ?? FLOORS.other;
}

/** Furniture colours, kept few so a furnished room reads as one composition. */
export const FURNITURE_COLOURS = {
  soft: "#b9bcc4",
  softDark: "#8e929c",
  timber: "#a9865c",
  timberDark: "#8a6a45",
  white: "#f4f4f2",
  metal: "#c2c6cb",
  dark: "#4d5560",
  glassy: "#cfe0ea",
} as const;

export const BASEBOARD_HEIGHT = 0.09;
export const BASEBOARD_DEPTH = 0.015;
