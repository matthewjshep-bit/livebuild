import { roomKinds } from "@/lib/plan/room-kind";

/**
 * Make the house contain the rooms the listing says it contains.
 *
 * The room list is assembled from two sources, and both under-count. A
 * description is optional and often absent. Photographs are the other source,
 * and a photographer shoots what sells a house: the kitchen from four angles,
 * the primary suite, the yard - and not the third bedroom, not the hall bath,
 * not the room with the exercise bike in it. Twenty photographs of a four-bed
 * house routinely name six rooms.
 *
 * So a house built from photographs alone comes out smaller than the house is,
 * and it does it silently: nothing in the pipeline ever knew a bedroom was
 * missing, because nothing ever compared what was built against what was
 * advertised. "3 bed / 2 bath" is the one fact about a property that is always
 * present, always structured, and never wrong - it is the headline of every
 * listing - and until now it reached the model as decoration on the review
 * screen and nothing else.
 *
 * This is the comparison. It only ever *adds*: a room somebody photographed
 * exists whatever the listing says, and a listing that undercounts is a listing
 * being conservative about a converted garage. Evidence outranks metadata in
 * one direction only.
 */

export type RoomEntry = { label: string; level: number };

/** What the listing claims. Either may be missing; halves are honoured. */
export type Inventory = {
  beds: number | null;
  /** 2.5 means two full bathrooms and a powder room. */
  baths: number | null;
};

export type Reconciled = {
  rooms: RoomEntry[];
  /** What had to be invented, so the user can see it and correct it. */
  added: RoomEntry[];
  /** One line per shortfall, for the build's running commentary. */
  notes: string[];
};

/** Whether a label names a bedroom, counting a primary suite as one. */
const isBed = (label: string) =>
  roomKinds(label).some((k) => k === "bedroom" || k === "primary-bedroom");

const isFullBath = (label: string) => roomKinds(label).some((k) => k === "bathroom");
const isPowder = (label: string) => roomKinds(label).some((k) => k === "powder");

/**
 * Which storey to put an invented room on.
 *
 * Beside its own kind wherever possible - a fourth bedroom belongs with the
 * other three, not on whichever floor happens to be first. With nothing of its
 * kind to sit beside it goes on the ground floor, which for a single-storey
 * house is the only answer and for a two-storey one is the safer wrong guess:
 * a bedroom downstairs is a room in the wrong place, whereas a bedroom on a
 * storey the house does not have is not a room at all.
 */
function levelBeside(rooms: RoomEntry[], like: (label: string) => boolean): number {
  const levels = rooms.filter((r) => like(r.label)).map((r) => r.level);
  if (levels.length === 0) return 0;
  const tally = new Map<number, number>();
  for (const level of levels) tally.set(level, (tally.get(level) ?? 0) + 1);
  return [...tally].sort((a, z) => z[1] - a[1])[0][0];
}

/**
 * The next free name in a numbered series.
 *
 * Numbering continues past what is there rather than filling gaps, so an added
 * room never takes a name that a photograph's room already answers to - two
 * rooms called "Bedroom 2" would be matched photographs by `placePhotos` at
 * random, and the failure would look like a bug in the layout.
 */
function nextName(taken: Set<string>, stem: string): string {
  if (!taken.has(stem)) return stem;
  for (let n = 2; n < 40; n++) {
    const candidate = `${stem} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem} ${taken.size + 1}`;
}

export function reconcileInventory(rooms: RoomEntry[], facts: Inventory): Reconciled {
  const out = [...rooms];
  const added: RoomEntry[] = [];
  const notes: string[] = [];
  const taken = new Set(rooms.map((r) => r.label));

  const want = (need: number | null, have: number, stem: string, like: (l: string) => boolean) => {
    if (need === null || !Number.isFinite(need)) return;
    const short = Math.round(need) - have;
    if (short <= 0) return;
    const level = levelBeside(out, like);
    for (let i = 0; i < short; i++) {
      const label = nextName(taken, stem);
      taken.add(label);
      const room = { label, level };
      out.push(room);
      added.push(room);
    }
  };

  const beds = out.filter((r) => isBed(r.label)).length;
  want(facts.beds, beds, "Bedroom", isBed);
  if (facts.beds !== null && Math.round(facts.beds) > beds) {
    notes.push(
      `The listing says ${Math.round(facts.beds)} bedrooms and the photos only showed ${beds} — added the ${Math.round(facts.beds) - beds} that were not pictured.`,
    );
  }

  // A "2.5 bath" house has two rooms with a bath in them and one without.
  // Counted separately because they are different rooms, and because a powder
  // room added as a bathroom would be built with a shower in it.
  if (facts.baths !== null && Number.isFinite(facts.baths)) {
    const full = Math.floor(facts.baths);
    const half = facts.baths - full >= 0.5 ? 1 : 0;

    const haveFull = out.filter((r) => isFullBath(r.label)).length;
    const havePowder = out.filter((r) => isPowder(r.label)).length;

    want(full, haveFull, "Bathroom", isFullBath);
    want(half, havePowder, "Powder Room", isPowder);

    const shortFull = Math.max(0, full - haveFull);
    const shortHalf = Math.max(0, half - havePowder);
    if (shortFull + shortHalf > 0) {
      const said: string[] = [];
      if (shortFull > 0) said.push(`${shortFull} bathroom${shortFull === 1 ? "" : "s"}`);
      if (shortHalf > 0) said.push("a powder room");
      notes.push(
        `The listing says ${facts.baths} bath — added ${said.join(" and ")} the photos did not show.`,
      );
    }
  }

  return { rooms: out, added, notes };
}
