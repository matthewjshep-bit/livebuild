/**
 * The roads round a building, so somebody can tell which way it faces.
 *
 * The drawing pad showed a dashed outline of the building and nothing else,
 * which is enough to trace and not enough to orient: whether the front door is
 * on the left or the right of your drawing is not a thing you can read off a
 * rectangle, and getting it wrong stayed invisible until the plan was sitting
 * on the satellite photograph two steps later.
 *
 * Deliberately vector rather than the `hybrid` map tile, which carries the same
 * names burnt into its pixels. `imagery.ts` fetches `satellite` precisely so a
 * label cannot end up lying across a roof, and undoing that here to save a
 * request would put the road names back on top of the thing being drawn.
 *
 * Apart from `footprint.ts` because that module is `server-only` and this is
 * not: the type crosses to the browser on every listing, and the grouping is
 * worth checking without a network.
 */

export type Street = {
  name: string;
  /** The `highway` tag of its first way: residential, tertiary, primary... */
  kind?: string;
  /**
   * The centreline as OpenStreetMap holds it, in [lat, lon], one run per way.
   *
   * Separate runs rather than one list, because a road is split at every
   * junction and every change of surface: joining them end to end would draw a
   * line from the end of one piece to the start of the next, straight across
   * whatever lies between.
   */
  ways: Array<Array<[number, number]>>;
};

/**
 * The kinds of way worth drawing, and the kinds that would just be clutter.
 *
 * Driveways, footpaths and alleys are `highway` too, and on a residential plot
 * there are more of them than there are streets. What the pad is for is
 * answering "which way is the house facing", and the answer to that is always a
 * road with a name on it.
 */
const STREET_KINDS = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "living_street",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link",
]);

export type OverpassWay = {
  type: string;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
};

/**
 * Which of Overpass's ways are streets, grouped so each is named once.
 *
 * What it throws away is most of what comes back: on a residential plot the
 * driveways, the pavements and the alley behind outnumber the roads, and every
 * one of them is a `highway`. Grouping by name matters as much - a road is
 * split at every junction, so one street routinely arrives as five ways and
 * would otherwise be labelled five times down its own length.
 */
export function streetsFrom(elements: OverpassWay[]): Street[] {
  const byName = new Map<string, { kind: string; ways: Array<Array<[number, number]>> }>();

  for (const element of elements) {
    if (element.type !== "way") continue;
    const name = element.tags?.name?.trim();
    const kind = element.tags?.highway;
    if (!name || !kind || !STREET_KINDS.has(kind)) continue;
    if ((element.geometry?.length ?? 0) < 2) continue;

    /**
     * Six decimal places, which is about eleven centimetres.
     *
     * These are stored on the import record so a reload still shows the
     * streets, and the record lives in localStorage. Full float precision on a
     * few hundred road vertices is kilobytes of digits describing a position to
     * the nanometre, for a line drawn a pixel wide. The pen strokes are rounded
     * on the way in for the same reason.
     */
    const points = element.geometry!.map(
      (p) =>
        [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6] as [number, number],
    );
    const existing = byName.get(name);
    if (existing) existing.ways.push(points);
    else byName.set(name, { kind, ways: [points] });
  }

  return [...byName].map(([name, { kind, ways }]) => ({ name, kind, ways }));
}

/**
 * A building near the house, as the map holds it.
 *
 * The outline in [lat, lon] like a street, and what the map knows of its
 * height - which is usually nothing, sometimes a storey count, rarely metres.
 * Kept so the house can be shown among its neighbours rather than alone on a
 * lawn: how a building sits on its street is half of what a photograph of it
 * shows, and none of it was being kept.
 */
export type NearbyBuilding = {
  ring: Array<[number, number]>;
  kind: string | null;
  levels: number | null;
  heightM: number | null;
  wayId: number;
};
