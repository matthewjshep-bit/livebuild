import { type BuildPhoto, type BuildStep, labelPhotos, roomHints } from "@/lib/build/pipeline";
import type { HouseCondition } from "@/lib/bom/condition";
import type { ListingFacts, ListingFootprint } from "@/lib/listing/types";
import type { HouseSpec } from "@/lib/plan/describe";
import { type Footprint, prepareFootprint } from "@/lib/plan/footprint";
import { type RoomEntry, reconcileInventory } from "@/lib/plan/inventory";
import { readExterior } from "@/lib/site/client";
import { GOOGLE_ATTRIBUTION } from "@/lib/site/geo";
import { mergeExterior } from "@/lib/site/osm";
import { syntheticRing } from "@/lib/site/trace";
import type { Exterior } from "@/lib/schema";
import type { NearbyBuilding, Street } from "@/lib/listing/streets";

/**
 * Everything known about a house before anything is built.
 *
 * The build used to be one function: find out about the house, decide where the
 * rooms go, and construct it, in one pass with no seam. That was right while
 * the layout was a guess - nobody was going to interrupt a guess - and it is
 * wrong now that the layout is something a person draws. You cannot stop
 * halfway through a function to ask a question.
 *
 * So this is the first half, and the seam is deliberately a plain value: no
 * React state, no callbacks kept, nothing that needs a browser. It is a
 * complete description of what the evidence says, which is what lets it be
 * written to the intake record and read back after a reload - the difference
 * between closing a tab and losing an afternoon, and between correcting a
 * layout and paying for every classify call a second time.
 *
 * What it deliberately does *not* do is arrange the rooms. That was the last
 * thing in this half and is now the first thing in the next one, because
 * arranging is the decision the user is being handed.
 */

/** How many distinct spaces a "room" build may come out as. */
const MAX_ROOM_MODE_SPACES = 3;

export type BuildEvidence = {
  /** Bumped if the shape changes, so a stale saved brief is ignored not misread. */
  version: 1;
  /** The photographs, now knowing which room each one is of. */
  photos: BuildPhoto[];
  /** Room pairs seen through an opening. The strongest layout evidence there is. */
  adjacency: Array<[string, string]>;
  /** Every room the house should contain, after the listing's bed/bath count. */
  rooms: RoomEntry[];
  /** Rooms the listing implied that no photograph showed. */
  addedByInventory: string[];
  outside: Exterior | null;
  houseCondition: HouseCondition;
  /** Prepared once. Null when nothing measured or invented a shape. */
  footprint: Footprint | null;
  shapeFrom: "map" | "traced" | "invented" | "none";
  storeys: number;
  /** What it worked out and why, in the order it worked it out. */
  notes: string[];
  /**
   * The streets and neighbours the map returned, with the frame to put them
   * on the plan. Optional: an evidence record saved before this existed
   * resumes without them, and a house with no map has none.
   */
  surroundings?: {
    frame: NonNullable<ListingFootprint["frame"]>;
    streets: Street[];
    buildings: NearbyBuilding[];
  } | null;
};

export type GatherInput<T extends BuildPhoto> = {
  /**
   * Whether this is one room or a whole house.
   *
   * A room needs none of the second half of this function - no exterior, no
   * outline, no bed and bath count to reconcile against - and it needs one
   * thing a house does not: the photographs are all of the same small number of
   * spaces, and saying so is what stops twelve pictures of a kitchen being
   * scattered across nine rooms.
   */
  mode?: "room" | "house";
  photos: T[];
  /** The described room list, when the house was described. */
  spec: HouseSpec | null;
  facts: ListingFacts | null;
  footprint: ListingFootprint | null;
  site: { lat: number; lon: number } | null;
  exterior: Exterior | null;
};

export type GatherResult<T extends BuildPhoto> = {
  evidence: BuildEvidence;
  /**
   * The caller's own photo objects, now labelled.
   *
   * Returned separately from `evidence.photos` rather than folded into it,
   * because they are not the same thing. `ImportedPhoto` carries a `File`
   * handle, which does not survive being written to disk and does not survive a
   * reload; the evidence has to. So the evidence keeps the four fields that
   * describe a photograph and these keep everything the page still needs in
   * memory.
   */
  photos: T[];
};

export async function gatherEvidence<T extends BuildPhoto>(
  input: GatherInput<T>,
  onStep?: (step: BuildStep | null) => void,
): Promise<GatherResult<T>> {
  const notes: string[] = [];

  // --- 1. What room is each photo? ---
  const read = await labelPhotos(input.photos, roomHints(input.spec), onStep);
  const labelled = read.photos;
  if (read.adjacency.length > 0) {
    notes.push(
      `Spotted ${read.adjacency.length} connection${read.adjacency.length === 1 ? "" : "s"} between rooms in the photos.`,
    );
  }

  let roomLabels: string[] = [];
  for (const photo of labelled) {
    if (photo.roomLabel && !roomLabels.includes(photo.roomLabel)) roomLabels.push(photo.roomLabel);
  }

  /**
   * A room is a room, however many ways the classifier saw it.
   *
   * Photographs of one kitchen come back labelled kitchen, dining, living and
   * hallway - not because the model is wrong but because a kitchen photographed
   * from the doorway genuinely contains a doorway. For a house that is useful
   * evidence; for a room it is nine rooms where there is one.
   *
   * So the labels are ranked by how many photographs carry them and the tail is
   * folded into the most popular. Three rather than one, because an open-plan
   * kitchen and diner or a bedroom with its ensuite are what people actually
   * photograph together, and forcing those into a single space would be its own
   * kind of wrong.
   */
  if (input.mode === "room" && roomLabels.length > 0) {
    const tally = new Map<string, number>();
    for (const photo of labelled) {
      if (!photo.roomLabel) continue;
      tally.set(photo.roomLabel, (tally.get(photo.roomLabel) ?? 0) + 1);
    }
    const ranked = [...tally].sort((a, z) => z[1] - a[1]).map(([label]) => label);
    const keep = ranked.slice(0, MAX_ROOM_MODE_SPACES);
    const folded = keep.length > 0 ? keep : roomLabels.slice(0, 1);

    let moved = 0;
    for (const photo of labelled) {
      if (photo.roomLabel && !folded.includes(photo.roomLabel)) {
        photo.roomLabel = folded[0];
        moved++;
      }
    }
    if (moved > 0) {
      notes.push(
        `${moved} photo${moved === 1 ? "" : "s"} looked like another room from the doorway; kept ${moved === 1 ? "it" : "them"} with the ${folded[0].toLowerCase()}.`,
      );
    }
    roomLabels = folded;
  }

  // --- 2. What does the house look like from outside? ---
  //
  // Before the layout, which is the whole point: a ranch read correctly as a
  // single-storey hip-roofed house used to be packed into a rectangle invented
  // from a table of typical room sizes, because this ran afterwards. Skipped
  // without a site, and failing quietly - a house down a private track has no
  // street view, and that is not an error.
  const houseMode = input.mode !== "room";
  let outside = input.exterior;
  let tracedRing: Array<[number, number]> | null = null;
  let tracedConfidence: "high" | "low" | null = null;
  let houseCondition: HouseCondition = {};

  if (houseMode && input.site) {
    onStep?.({ label: "Looking at the outside", done: 0, total: 1 });
    const seen = await readExterior({
      lat: input.site.lat,
      lon: input.site.lon,
      outline: input.footprint?.outline ?? [],
      storeys: input.exterior?.storeys ?? null,
    });
    outside = mergeExterior(input.exterior, seen?.exterior ?? null);
    houseCondition = seen?.condition ?? {};
    tracedRing = seen?.tracedRing ?? null;
    tracedConfidence = seen?.tracedConfidence ?? null;

    const said = [
      seen?.exterior?.storeys ? `${seen.exterior.storeys} storeys` : null,
      seen?.exterior?.roof?.shape ? `a ${seen.exterior.roof.shape} roof` : null,
      seen?.exterior?.walls?.material ?? null,
    ].filter(Boolean);
    if (said.length > 0) {
      notes.push(`Looked at the house from the street and the air: ${said.join(", ")}.`);
    }
    const needing = Object.entries(houseCondition).filter(
      ([, grade]) => grade === "dated" || grade === "poor",
    );
    if (needing.length > 0) {
      notes.push(
        `Graded the outside from that: ${needing.map(([element, grade]) => `${element} ${grade}`).join(", ")}.`,
      );
    }
  }

  // --- 3. Which rooms does the house have? ---
  const described = input.spec?.rooms ?? [];
  const describedLabels = new Set(described.map((r) => r.label));
  const extras = roomLabels
    .filter((l) => !describedLabels.has(l))
    .map((l) => ({ label: l, level: 0 }));
  const source = [...described, ...extras];
  let rooms: RoomEntry[] =
    source.length > 0 ? source : roomLabels.map((l) => ({ label: l, level: 0 }));

  // A room with no photographs at all is nothing to build; a *house* with none
  // is still a house, and gets the typical one below.
  if (rooms.length === 0 && !houseMode) {
    return {
      evidence: {
        version: 1,
        photos: [],
        adjacency: [],
        rooms: [],
        addedByInventory: [],
        outside: null,
        houseCondition: {},
        footprint: null,
        shapeFrom: "none",
        storeys: 1,
        notes: ["No room could be made out from those photographs."],
      },
      photos: labelled,
    };
  }

  if (rooms.length === 0) {
    rooms = [
      "Living Room", "Kitchen", "Dining Room", "Primary Bedroom",
      "Bedroom 2", "Bedroom 3", "Bathroom", "Bathroom 2", "Hallway",
    ].map((label) => ({ label, level: 0 }));
    notes.push(
      "No room details were available, so this is a typical three-bedroom plan — correct it below.",
    );
  }

  // A listing's bed and bath count says nothing about a single room, and
  // applying it would add eight rooms nobody photographed.
  const inventory = houseMode
    ? reconcileInventory(rooms, {
        beds: input.facts?.beds ?? null,
        baths: input.facts?.baths ?? null,
      })
    : { rooms, added: [], notes: [] };
  rooms = inventory.rooms;
  notes.push(...inventory.notes);

  // Trust the count derived from the two areas over the number of levels the
  // room list happens to use - a description that never mentioned an upstairs
  // would otherwise squash a two-storey house onto one floor.
  const storeys = Math.max(
    input.footprint?.storeys ?? 1,
    new Set(rooms.map((r) => r.level)).size,
  );

  // --- 4. What shape is the building? ---
  //
  // The map first, because it is measured. Then the satellite trace, because a
  // shape read off a photograph of the actual building beats a rectangle
  // invented from a table of typical room sizes. Then, failing both, that
  // rectangle - but with a house's proportions rather than a square, which is
  // the difference between a ranch and a block of flats.
  let ring = houseMode ? (input.footprint?.ring ?? null) : null;
  let shapeFrom: BuildEvidence["shapeFrom"] = ring ? "map" : "none";

  if (!ring && tracedRing) {
    ring = tracedRing;
    shapeFrom = "traced";
    notes.push(
      tracedConfidence === "low"
        ? "No building is drawn on the map here, so the outline was read off the satellite image — parts of it were obscured, so check the shape below."
        : "No building is drawn on the map here, so the outline was read off the satellite image.",
    );
  }
  if (!ring && houseMode && input.site) {
    ring = syntheticRing(input.site, input.facts?.sqft ? input.facts.sqft / storeys : 1600);
    shapeFrom = "invented";
    notes.push(
      "Neither the map nor the satellite gave a usable outline, so this is a typical single-storey shape — drag it about below.",
    );
  }

  // Prepared once and kept, because the angle it had to turn the building
  // through to square it up is also what tells the sun which way the house
  // faces. Preparing it twice would be cheap; forgetting the rotation is how a
  // traced house ends up lit from the wrong side.
  const groundRooms = Math.max(1, rooms.filter((r) => r.level === 0).length);
  const footprint = ring
    ? prepareFootprint(
        ring,
        // The outline is the ground floor, so the listing's total area has to
        // be divided by the storeys standing on it.
        input.facts?.sqft ? input.facts.sqft / storeys : undefined,
        groundRooms,
        // A traced ring is a guess and the stated floor area is a fact, so the
        // area is allowed to correct it much harder than it may correct a
        // surveyed outline.
        shapeFrom === "map" ? "measured" : "traced",
      )
    : null;

  // Worth saying out loud, and saying *which* - a surveyed outline and one read
  // off a photograph are not the same claim, and each carries a licence that
  // requires crediting wherever it is shown.
  if (input.footprint && shapeFrom === "map") {
    notes.push(
      `Shaped to the real building outline from the map (${Math.round(input.footprint.areaSqft)} sqft ground floor). ${input.footprint.attribution}.`,
    );
  } else if (footprint && shapeFrom === "traced") {
    notes.push(
      `Shaped to the building as seen from above (${Math.round(footprint.areaSqft)} sqft ground floor). ${GOOGLE_ATTRIBUTION}.`,
    );
    if (tracedConfidence === "low") {
      notes.push(
        "The satellite trace was not confident about this building — check the outline against the roof before building.",
      );
    }
  }

  const evidence: BuildEvidence = {
    version: 1,
    photos: labelled.map((p) => ({
      id: p.id,
      ref: p.ref,
      roomLabel: p.roomLabel,
      guessed: p.guessed,
    })),
    adjacency: read.adjacency,
    rooms,
    addedByInventory: inventory.added.map((r) => r.label),
    outside,
    houseCondition,
    footprint,
    shapeFrom,
    storeys,
    notes,
    // The frame the drawing pad drew against comes first: that is what the
    // rooms were registered to. A traced or invented ring has its own frame
    // and whatever roads the listing found.
    surroundings: input.footprint?.frame
      ? {
          frame: input.footprint.frame,
          streets: input.footprint.streets ?? [],
          buildings: input.footprint.buildings ?? [],
        }
      : footprint?.frame
        ? {
            frame: footprint.frame,
            streets: input.footprint?.streets ?? [],
            buildings: input.footprint?.buildings ?? [],
          }
        : null,
  };

  return { evidence, photos: labelled };
}
