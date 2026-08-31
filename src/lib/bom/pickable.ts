import type { Bom, BomLine, BomRoom } from "@/lib/bom/build";
import type { Element } from "@/lib/bom/condition";

/**
 * What you are looking at, and what it costs.
 *
 * The bill of materials already knows a room's scope; this connects it to the
 * thing on screen. Clicking a bath should show what the bath costs, not make
 * you find "Sanitaryware" in a list somewhere else - which is the difference
 * between a document about a house and a model of one.
 */

/**
 * Which condition element a piece of furniture stands for.
 *
 * Only fixtures map. A bed and a sofa are staging: they make a room read as
 * lived in, and replacing them is not rehab scope, so clicking one selects its
 * room rather than pretending there is a line item behind it.
 */
const PIECE_ELEMENT: Record<string, Element> = {
  bath: "bathing",
  basin: "vanity",
  wc: "toilet",
  counter: "counters",
  island: "counters",
  fridge: "appliances",
  machines: "appliances",
};

export function elementForPiece(kind: string): Element | null {
  return PIECE_ELEMENT[kind] ?? null;
}

/** What a pick resolves to: a room, and optionally one element within it. */
export type Pick = { roomId: string; element: Element | null };

export type PickDetail = {
  room: BomRoom;
  element: Element | null;
  /** Lines for the element, or every line in the room when none is selected. */
  lines: BomLine[];
  total: number;
  /** True when the element has no lines because nothing needs doing. */
  nothingNeeded: boolean;
};

/**
 * Resolve a pick against the built BOM.
 *
 * Returns the room even when the element has no lines - "this needs nothing" is
 * an answer, and a pane that vanishes when you click a sound bath is worse than
 * one that says the bath is fine.
 */
export function detailFor(bom: Bom, pick: Pick | null): PickDetail | null {
  if (!pick) return null;

  const room = bom.rooms.find((r) => r.roomId === pick.roomId);
  if (!room) return null;

  const all = room.assemblies.flatMap((a) => a.lines);
  const lines = pick.element
    ? all.filter((line) => line.because.element === pick.element)
    : all;

  return {
    room,
    element: pick.element,
    lines,
    total: lines.reduce((sum, line) => sum + line.total, 0),
    nothingNeeded: lines.length === 0,
  };
}

/** Human label for an element, for the pane's heading. */
export const ELEMENT_LABEL: Record<Element, string> = {
  floor: "Flooring",
  walls: "Walls",
  ceiling: "Ceiling",
  trim: "Trim & doors",
  lighting: "Lighting",
  cabinets: "Cabinets",
  counters: "Worktops",
  appliances: "Appliances",
  backsplash: "Backsplash",
  vanity: "Vanity & basin",
  bathing: "Bath / shower",
  toilet: "WC",
  tile: "Tiling",
};

/** One room's scope, as its own project rather than a slice of the house's. */
export type RoomScope = {
  room: BomRoom;
  /** The room's own totals. Never the house's - see below. */
  total: number;
  material: number;
  labour: number;
  lineCount: number;
  /**
   * Windows this room has, which its cost does **not** include.
   *
   * They are counted per room in the takeoff and then priced once, house-wide,
   * as a single `house:windows` line under Exterior - because a glazing job is
   * quoted for a building, not a bedroom. So a room with six windows shows no
   * window cost, and re-deriving one here would double-count it against the
   * house total. The number is carried instead so the room view can say so; a
   * cost that is quietly absent is worse than one that is explained.
   */
  windowCount: number;
};

/**
 * A room's scope on its own terms.
 *
 * Every figure comes from the room's own branch of the BOM. **Nothing here may
 * fall back to `bom.total`, `bom.material`, `bom.labour`, `bom.lineCount`,
 * `bom.assumedTotal` or `bom.sanity`** - the first four are house-wide sums
 * that include the roof, the systems and the exterior, and `sanity` compares a
 * whole project against rehab bands by house size, which means nothing for a
 * bathroom. Presenting any of them beside a room's name would be wrong by the
 * cost of a roof.
 */
export function roomScope(bom: Bom, roomId: string | null | undefined): RoomScope | null {
  if (!roomId) return null;
  const room = bom.rooms.find((r) => r.roomId === roomId);
  if (!room) return null;

  return {
    room,
    total: room.total,
    material: room.material,
    labour: room.labour,
    lineCount: room.assemblies.reduce((sum, a) => sum + a.lines.length, 0),
    windowCount: room.takeoff.windowCount,
  };
}
