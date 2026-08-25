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
