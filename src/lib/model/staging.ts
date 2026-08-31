import { type Piece, furnishRoom } from "@/lib/model/furniture";
import { elementForPiece } from "@/lib/bom/pickable";
import type { RoomSpec } from "@/lib/spec/schema";
import type { Plan, Room } from "@/lib/schema";

/**
 * What stands in a room, once the staging has been taken out.
 *
 * "Unfurnished" does not mean empty. A bath, a WC, a basin, a run of counter
 * and the appliances built into it are part of the house - they are what the
 * buyer is purchasing and what the scope of work prices. A bed and a sofa are
 * somebody else's belongings, and they are the one thing in a photograph
 * guaranteed not to be there on completion.
 *
 * The split already existed and was already meaningful: `elementForPiece` maps
 * the fixtures onto real bill-of-materials elements and returns null for the
 * staging, precisely because staging has no line item behind it. So the rule is
 * that null, and it is written here once because both the model and the 2D plan
 * have to agree - a drawing that keeps showing beds after they have been turned
 * off in 3D is worse than not having the switch.
 */
export function piecesFor(
  plan: Plan,
  room: Room,
  furnished: boolean,
  /** What the room has fitted, so the two generators do not both supply it. */
  spec?: RoomSpec | null,
): Piece[] {
  /**
   * Whatever the fitted joinery already covers, the furniture generator must
   * not also invent.
   *
   * `furnishRoom` has always put a counter run in a kitchen and a slab of an
   * island in a large one, because until now nothing else did. Once the spec
   * supplies real cabinetry the two overlap - and the result is not a visual
   * glitch you would notice, it is a second worktop occupying the same wall and
   * a kitchen priced twice.
   */
  const fitted = new Set((spec?.joinery ?? []).map((item) => item.kind));
  const supersededByJoinery = (kind: string) =>
    (kind === "counter" && fitted.has("cabinet-run")) ||
    (kind === "island" && fitted.has("island")) ||
    (kind === "basin" && fitted.has("vanity")) ||
    (kind === "wardrobe" && fitted.has("wardrobe"));

  return furnishRoom(plan, room).filter(
    (piece) =>
      !supersededByJoinery(piece.kind) &&
      (furnished || elementForPiece(piece.kind) !== null),
  );
}
