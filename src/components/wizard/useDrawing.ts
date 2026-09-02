"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type HouseSheet, sheetToSpec } from "@/lib/plan/house-sheet";
import { isStairs, roomKind } from "@/lib/plan/room-kind";
import { levelName } from "@/lib/plan/geometry";
import type { Label, Stroke } from "@/lib/plan/strokes";
import { latLonToPlan } from "@/lib/site/frame";
import type { ListingFootprint } from "@/lib/listing/types";
import type { Room, Vec2 } from "@/lib/schema";

/**
 * The drawing, across every storey of the house.
 *
 * Eleven things in the wizard served one idea - which floor is being drawn,
 * what is on each of them, what the sheet says still needs drawing, what to
 * trace, what the last reading complained about - and they sat interleaved with
 * photographs, listing facts and publish state in a component with
 * thirty-three `useState` calls. Reading any one of them meant reading all of
 * them.
 *
 * They stay in the page's own render rather than moving into the board, because
 * two things outside the drawing need them: the intake record persists the
 * strokes, which are the one part of the wizard that cannot be recovered by
 * asking again, and the satellite step needs to know whether what it is showing
 * came from a pen. A hook keeps both of those true and still gives the concern
 * one name and one place to change.
 */

/** Stable empties, so an undrawn storey does not remount the board every render. */
const EMPTY_STROKES: Stroke[] = [];
const EMPTY_LABELS: Label[] = [];

export type Pen = Record<number, { strokes: Stroke[]; labels: Label[] }>;

export function useDrawing({
  sheet,
  footprint,
}: {
  sheet: HouseSheet;
  footprint: ListingFootprint | null;
}) {
  const [pen, setPen] = useState<Pen>({});
  const [level, setLevel] = useState(0);
  /** What each storey read as, kept until every storey has been drawn. */
  const [byLevel, setByLevel] = useState<Record<number, Room[]>>({});
  /** Something wrong with a drawing that only the whole house can see. */
  const [problem, setProblem] = useState<string | null>(null);
  /** What the drawing read as, before the building has had its say on size. */
  const [rooms, setRooms] = useState<Room[] | null>(null);
  /**
   * What the reading had to tidy, kept where the build can reach it.
   *
   * A ref rather than state because the build overwrites its notes wholesale
   * with what it found, and it runs in the same pass that sets them - so
   * "straightened nine walls, closed sixteen corners" would be written and then
   * immediately thrown away. These are the surprises the drawing was told about
   * and they belong beside the build's own.
   */
  const notesRef = useRef<string[]>([]);

  /**
   * The storeys to draw, in the order somebody would walk them.
   *
   * Straight off the sheet, because the sheet is what decides how many floors
   * the house has. Drawing only the ground floor and letting the packer invent
   * the rest would put an upstairs nobody drew above a ground floor somebody
   * did - and the stairs would have to line up between the two by luck.
   */
  const levels = useMemo(() => {
    const found = new Set(sheetToSpec(sheet).rooms.map((room) => room.level));
    return [...found].sort((a, z) => a - z);
  }, [sheet]);

  // A storey that stops existing - the floor count came down - must not keep a
  // drawing that would be built anyway.
  useEffect(() => {
    if (!levels.includes(level)) setLevel(levels[0] ?? 0);
  }, [levels, level]);

  /**
   * The rooms the sheet says this storey has, offered as chips on the pad.
   *
   * So the names the layout is packed from and the names the classifier may
   * choose from are the same words, rather than a spelling test.
   */
  const wanted = useMemo(
    () =>
      sheetToSpec(sheet)
        .rooms.filter((room) => room.level === level && roomKind(room.label) !== "outside")
        .map((room) => room.label),
    [sheet, level],
  );

  /**
   * The building to draw inside, when the map measured one.
   *
   * `footprint.outline` is already the simplified, squared-up shape in metres,
   * and it is in state before the drawing stage is reached, so this costs
   * nothing. Handing it to the pad does two things: it gives an outline to
   * trace, so the house comes out this building's shape rather than a rectangle
   * to be repacked afterwards, and it fixes the pad's scale, so what is drawn
   * is already in real metres.
   *
   * The same outline for every storey. An upper floor stands on the ground
   * floor's footprint, which is exactly the assumption the packer has always
   * made when it puts every level inside one outline.
   */
  const guide = useMemo(() => {
    const outline = footprint?.outline;
    if (!outline || outline.length < 4) return null;
    const xs = outline.map((p) => p[0]);
    const ys = outline.map((p) => p[1]);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    // A pen stroke is a handful of pixels wide, so the paper has to be big
    // enough that a wall is a line rather than a smudge.
    if (!(span > 1)) return null;

    /**
     * The streets, in the same metres the outline is in.
     *
     * `latLonToPlan` is the whole of it - projection, rotation, offset and
     * scale, the four things `prepareFootprint` did to the building, applied to
     * anything else on the map so it lands in register. It is round-tripped
     * against its own inverse in `frame-test`, which is the only way to be sure
     * of arithmetic where being wrong looks plausible.
     *
     * Because the outline was squared up on its dominant wall, the streets
     * arrive at their true angle *to the building* rather than to north - and
     * that angle is exactly the thing somebody is trying to read off the pad.
     */
    const frame = footprint?.frame ?? null;
    const streets = frame
      ? (footprint?.streets ?? []).map((street) => ({
          name: street.name,
          ways: street.ways.map((way) =>
            way.map(([lat, lon]) => latLonToPlan(frame, lat, lon)),
          ),
        }))
      : [];

    return { outline: outline as Vec2[], metresPerPixel: span / 700, streets };
  }, [footprint]);

  /** The storey still to be drawn after this one, or null when this is the last. */
  const nextLevel = useMemo(
    () => levels.find((other) => other !== level && !byLevel[other]) ?? null,
    [levels, level, byLevel],
  );

  /**
   * Whether what is on the satellite canvas came from a pen.
   *
   * Not just `rooms`: a reload restores the layout and the strokes but not the
   * intermediate reading, and telling somebody to "place each room inside the
   * outline" about a plan they drew themselves is worse than saying nothing.
   */
  const cameFromPen =
    (rooms?.length ?? 0) > 0 || Object.values(pen).some((drawn) => drawn.strokes.length > 0);

  const strokes = pen[level]?.strokes ?? EMPTY_STROKES;
  const labels = pen[level]?.labels ?? EMPTY_LABELS;

  /**
   * One storey's strokes or labels, replaced or updated in place.
   *
   * Generic over which of the two, so `setStrokes` cannot be handed labels -
   * they are both arrays of objects and nothing but the type distinguishes
   * them.
   */
  const editPen = useCallback(
    <K extends "strokes" | "labels">(field: K, next: Pen[number][K] | ((previous: Pen[number][K]) => Pen[number][K])) =>
      setPen((current) => {
        const here = current[level] ?? { strokes: [], labels: [] };
        return {
          ...current,
          [level]: {
            ...here,
            [field]: typeof next === "function" ? next(here[field]) : next,
          },
        };
      }),
    [level],
  );

  const setStrokes = useCallback(
    (next: Stroke[] | ((previous: Stroke[]) => Stroke[])) => {
      // A wall has just moved, so a complaint about the last reading is about a
      // drawing that no longer exists.
      setProblem(null);
      editPen("strokes", next);
    },
    [editPen],
  );

  const setLabels = useCallback(
    (next: Label[] | ((previous: Label[]) => Label[])) => editPen("labels", next),
    [editPen],
  );

  /**
   * A storey has been read. Move to the next one, or hand back the house.
   *
   * Returns the whole house's rooms once every storey is drawn, and null while
   * any remain - so the caller has one thing to check rather than a sequence to
   * reproduce.
   */
  const acceptStorey = useCallback(
    (read: Room[], adjustments: string[]): Room[] | null => {
      /**
       * A storey with no way up it is not a storey.
       *
       * Stairs used to be placed by the packer, so nobody had to think about
       * them. They are drawn now, and a house whose upstairs has no staircase
       * is not visibly wrong anywhere - the plan looks fine, the rooms are all
       * there, and the only symptom is walking the tour and finding no way up.
       */
      if (levels.length > 1 && !read.some((room) => isStairs(room.label))) {
        // The one refusal left, and it earns it: a storey with no way up is
        // not untidy, it is unwalkable, and nothing about the plan shows it -
        // the rooms are all there and the failure only appears when somebody
        // walks the tour. Pointing at the chip matters because the chip has
        // been sitting in the list the whole time.
        setProblem(
          `This floor needs a staircase — the house has ${levels.length} floors and otherwise there is no way between them. Name a space using the Stairs chip below.`,
        );
        return null;
      }
      setProblem(null);

      // Rooms come off the board on level 0 whichever floor is being drawn,
      // because the board does not know about floors.
      const onLevel = read.map((room) => ({ ...room, level }));
      const all = { ...byLevel, [level]: onLevel };
      setByLevel(all);
      /**
       * Every storey's repairs, not the last one's.
       *
       * This assigned rather than appended, so a two-storey house reported what
       * the upstairs had to be tidied for and silently dropped the ground
       * floor's - which is the floor with most of the rooms on it. Named per
       * storey, because "closed six corners" twice over reads like a glitch.
       */
      notesRef.current = [
        ...notesRef.current.filter((note) => !note.startsWith(`${levelName(level)}: `)),
        ...adjustments.map((note) =>
          levels.length > 1 ? `${levelName(level)}: ${note}` : note,
        ),
      ];

      const missing = levels.find((other) => !all[other]);
      if (missing !== undefined) {
        setLevel(missing);
        return null;
      }

      // Ids are unique per storey only, so they are made unique across the
      // house here - photographs and grades are keyed by room id, and two rooms
      // sharing one is how an upstairs bedroom ends up wearing the kitchen's
      // photographs.
      const together = levels.flatMap((other) =>
        (all[other] ?? []).map((room) => ({ ...room, id: `L${other}${room.id}` })),
      );
      setRooms(together);
      return together;
    },
    [byLevel, level, levels],
  );

  /** Adopt a plan that arrived already drawn - a photo of paper, or a listing. */
  const acceptImported = useCallback((read: Room[], adjustments: string[]) => {
    // One drawing, arriving whole, so it replaces rather than appends.
    notesRef.current = adjustments;
    setRooms(read);
  }, []);

  /** Restore strokes from a resumed intake record. */
  const restore = useCallback((drawings: Array<{ level: number; strokes: Stroke[]; labels: Label[] }>) => {
    setPen(
      Object.fromEntries(
        drawings.map((d) => [d.level, { strokes: d.strokes, labels: d.labels }]),
      ),
    );
  }, []);

  return {
    pen,
    level,
    setLevel,
    levels,
    byLevel,
    problem,
    setProblem,
    rooms,
    setRooms,
    notesRef,
    wanted,
    guide,
    nextLevel,
    cameFromPen,
    strokes,
    labels,
    setStrokes,
    setLabels,
    acceptStorey,
    acceptImported,
    restore,
  };
}
