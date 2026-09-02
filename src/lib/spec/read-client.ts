"use client";

import { getMedia, isManagedRef, refToKey } from "@/lib/media-store";
import { inferHouse } from "@/lib/spec/infer";
import {
  type HouseSpec,
  type RoomSpec,
  type Source,
  EMPTY_ROOM_SPEC,
  outranks,
} from "@/lib/spec/schema";
import { boundsOf, roomAdjacency } from "@/lib/plan/geometry";

import type { Property, Room } from "@/lib/schema";
import { policyFor } from "@/lib/ai/policy";
import { toJpegDataUrl } from "@/lib/photos/decode";

/**
 * Read every photographed room, then reason about the ones nobody shot.
 *
 * One request per room rather than one for the house, for the reason the
 * grading pass already gives: a room is described from its own pictures, and
 * mixing them invites the kitchen's worktop to turn up in the bathroom. Rooms
 * with no photographs are not sent at all - the inference has a better answer
 * for those than a model with nothing to look at.
 *
 * Saved room by room. This runs for minutes on a large house, after the tour is
 * already on screen, and a closed tab used to throw the lot away.
 */

/**
 * Bigger than the grading pass, and better quality.
 *
 * Grading asks about surfaces, which survive compression. This asks about
 * edges - a shaker door against a slab one, an ogee skirting against a square
 * one - and edges are the first thing a JPEG spends. The grading client makes
 * exactly this argument at 900px to justify going above the classifier's 768;
 * the same argument carries further here.
 */
// Taken from the policy so a draft build sends small pictures as well as
// asking a cheap model - images are half the cost of a build, and they are
// shrunk here on the client long before any route is reached.
const EDGE = policyFor("room-read").imageEdge;
const QUALITY = 0.88;
const MAX_PER_ROOM = 4;

/** Rooms at a time. Bigger payloads at high effort than the grading pass. */
const BATCH = 2;

export type ReadProgress = { room: string; done: number; total: number };

const thumbnail = (blob: Blob) => toJpegDataUrl(blob, EDGE, QUALITY);

/**
 * How big each room is, read off its own photographs.
 *
 * Used before anything is built, and only where nothing else could know - a
 * room built from photographs alone has no footprint, no map and no plan, so
 * the alternative is `typicalSize`, which gives every kitchen the same kitchen.
 *
 * Fails soft in every direction. A room the reading refuses, a request that
 * errors, no key at all: the caller gets nothing back for that room and falls
 * through to the typical size, which is exactly where it was before. The
 * measurement can make a room right; it is never the difference between a room
 * and no room.
 */
export async function measureRooms(
  byRoom: Array<{ label: string; photos: Blob[] }>,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, { widthM: number; depthM: number }>> {
  const out = new Map<string, { widthM: number; depthM: number }>();
  let done = 0;

  for (const room of byRoom) {
    const shots = (
      await Promise.all(room.photos.slice(0, MAX_PER_ROOM).map((blob) => thumbnail(blob)))
    ).filter((p): p is string => Boolean(p));

    if (shots.length > 0) {
      try {
        const response = await fetch("/api/room-read", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Deliberately no width or depth: their absence is what asks the
          // question, and the route says so in as many words.
          body: JSON.stringify({ room: room.label, photos: shots, neighbours: [] }),
        });
        if (response.ok) {
          const data = await response.json();
          if (data?.measured?.widthM > 0 && data?.measured?.depthM > 0) {
            out.set(room.label, {
              widthM: data.measured.widthM,
              depthM: data.measured.depthM,
            });
          }
        }
      } catch {
        // Nothing to do but use a typical room, which is what happens anyway.
      }
    }
    onProgress?.(++done, byRoom.length);
  }

  return out;
}

/** A room's photographs, from the store or from a bundled sample's folder. */
async function photosForRoom(property: Property, roomId: string): Promise<string[]> {
  const nodes = property.nodes.filter((n) => n.roomId === roomId).slice(0, MAX_PER_ROOM);
  const out: string[] = [];
  for (const node of nodes) {
    const blob = isManagedRef(node.photo)
      ? await getMedia(refToKey(node.photo))
      : await fetch(node.photo)
          .then((r) => (r.ok ? r.blob() : null))
          .catch(() => null);
    if (!blob) continue;
    const dataUrl = await thumbnail(blob);
    if (dataUrl) out.push(dataUrl);
  }
  return out;
}

type ReadResult = {
  floor?: { material: string | null; colour: string | null };
  walls?: { material: string | null; colour: string | null };
  ceiling?: {
    heightM: number | null;
    kind: string | null;
    colour: string | null;
    beams: { count: number; axis: "x" | "y" } | null;
  };
  trim?: { baseboardM: number | null; profile: string | null; colour: string | null };
  openings?: Array<{ toRoom: string; kind: string }>;
  joinery?: {
    doorStyle: string | null;
    colour: string | null;
    hasWallUnits: boolean;
    hasIsland: boolean;
    worktopMaterial: string | null;
    worktopColour: string | null;
    hardware: string | null;
  } | null;
  offStandard?: string[];
  dropped?: string[];
  notes?: string;
};

/** Write a read value in, without stepping on anything a person has said. */
function put(
  spec: RoomSpec,
  path: string,
  value: string | number | boolean | null | undefined,
  source: Source = "read",
): void {
  if (value === null || value === undefined) return;
  if (!outranks(source, spec.source[path])) return;

  const keys = path.split(".");
  const leaf = keys.pop()!;
  let node = spec as unknown as Record<string, unknown>;
  for (const key of keys) {
    if (node[key] === undefined || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[leaf] = value;
  spec.source[path] = source;
  delete spec.because[path];
}

export type ReadReport = {
  spec: HouseSpec;
  /** Rooms a photograph was actually read for. */
  read: number;
  /** Rooms with no photograph, left to the inference. */
  unseen: number;
  notes: string[];
};

export async function readRooms(
  property: Property,
  base: HouseSpec,
  onProgress?: (progress: ReadProgress) => void,
  /** Called as each room lands, so a closed tab loses one room and not all. */
  onRoom?: (roomId: string, spec: RoomSpec) => void,
): Promise<ReadReport> {
  const rooms = property.plan.rooms;
  const adjacency = roomAdjacency(property.plan);
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const nameOf = new Map(rooms.map((r) => [r.label.trim().toLowerCase(), r.id]));

  /**
   * Reason first, then read over the top.
   *
   * The inference is what decides *where* a run of units goes - which wall has
   * the clearest length, given the doorways - and a reading only ever describes
   * what the units look like, because a photograph cannot say which way is
   * north. So placement has to exist before appearance can be laid onto it;
   * run the other way round and every kitchen's door style and worktop is read
   * correctly and then quietly dropped, because there is nothing yet to put it
   * on.
   *
   * Running it twice is free and safe: it is pure, it only ever fills gaps, and
   * `infer-test` pins that a second pass changes nothing.
   */
  const spec: HouseSpec = inferHouse(property.plan, base).spec;
  const notes: string[] = [];
  let read = 0;
  let done = 0;

  const withPhotos = rooms.filter((room) =>
    property.nodes.some((node) => node.roomId === room.id),
  );
  const total = withPhotos.length;

  const one = async (room: Room) => {
    const photos = await photosForRoom(property, room.id);
    if (photos.length === 0) return;

    const b = boundsOf(room.polygon);
    const neighbourRooms = [...(adjacency.get(room.id) ?? [])]
      .map((id) => byId.get(id))
      .filter((r): r is Room => Boolean(r));

    let result: ReadResult | null = null;
    try {
      const response = await fetch("/api/room-read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          room: room.label,
          widthM: b.x1 - b.x0,
          depthM: b.y1 - b.y0,
          ceilingM: room.ceilingHeight,
          neighbours: neighbourRooms.map((r) => r.label),
          photos,
        }),
      });
      if (response.ok) result = (await response.json()) as ReadResult;
    } catch {
      // One room failing is one room the inference will fill in. The pass as a
      // whole must not stop for it - it runs after the tour is already up.
      result = null;
    }
    if (!result) return;

    const next: RoomSpec = {
      ...EMPTY_ROOM_SPEC,
      ...(spec.rooms[room.id] ?? {}),
      openings: { ...(spec.rooms[room.id]?.openings ?? {}) },
      source: { ...(spec.rooms[room.id]?.source ?? {}) },
      because: { ...(spec.rooms[room.id]?.because ?? {}) },
      observed: true,
    };

    put(next, "floor.material", result.floor?.material);
    put(next, "floor.colour", result.floor?.colour);
    put(next, "walls.material", result.walls?.material);
    put(next, "walls.colour", result.walls?.colour);
    put(next, "ceiling.heightM", result.ceiling?.heightM);
    put(next, "ceiling.kind", result.ceiling?.kind);
    put(next, "ceiling.colour", result.ceiling?.colour);
    put(next, "trim.baseboardM", result.trim?.baseboardM);
    put(next, "trim.profile", result.trim?.profile);
    put(next, "trim.colour", result.trim?.colour);

    if (result.ceiling?.beams) {
      put(next, "ceiling.beams.count", result.ceiling.beams.count);
      put(next, "ceiling.beams.axis", result.ceiling.beams.axis);
    }

    // Openings come back named by room label, because a name is what the model
    // was given and an id would have been a string it could shuffle.
    for (const opening of result.openings ?? []) {
      const otherId = nameOf.get(opening.toRoom.trim().toLowerCase());
      if (!otherId || otherId === room.id) continue;
      put(next, `openings.${otherId}.kind`, opening.kind);
    }

    /**
     * What the cabinets look like, laid over where the plan says they go.
     *
     * The reading describes appearance only - it was never asked which wall,
     * because a photograph does not say which way is north. So the wall, the
     * length and the depth stay whatever the inference worked out from the
     * plan, and only the things a photograph genuinely knows are overwritten.
     * Getting that division wrong is how a kitchen ends up with its units
     * confidently placed along a wall that has the door in it.
     */
    if (result.joinery) {
      const existing = next.joinery?.find((j) => j.kind === "cabinet-run" || j.kind === "vanity");
      const seen = result.joinery;
      if (existing) {
        next.joinery = next.joinery.map((item) =>
          item === existing
            ? {
                ...item,
                doorStyle: (seen.doorStyle as typeof item.doorStyle) ?? item.doorStyle,
                colour: seen.colour ?? item.colour,
                hardware: (seen.hardware as typeof item.hardware) ?? item.hardware,
                tier: seen.hasWallUnits ? "base+wall" : "base",
                worktop: item.worktop
                  ? {
                      ...item.worktop,
                      material:
                        (seen.worktopMaterial as typeof item.worktop.material) ??
                        item.worktop.material,
                      colour: seen.worktopColour ?? item.worktop.colour,
                    }
                  : item.worktop,
              }
            : item,
        );
        next.source["joinery"] = "read";
        delete next.because["joinery"];
      }

      // An island is a thing a photograph can genuinely see, and the plan
      // cannot infer: it depends on how the room is used, not how big it is.
      if (seen.hasIsland && !next.joinery.some((j) => j.kind === "island")) {
        next.joinery = [
          ...next.joinery,
          {
            id: `${room.id}-island`,
            kind: "island",
            wall: null,
            alongM: 0,
            lengthM: 0.45,
            depthM: 1,
            tier: "base",
            doorStyle: (seen.doorStyle as "shaker") ?? "shaker",
            colour: seen.colour ?? null,
            hardware: (seen.hardware as "bar") ?? "bar",
            worktop: {
              material: (seen.worktopMaterial as "quartz") ?? "quartz",
              colour: seen.worktopColour ?? null,
              thicknessM: 0.03,
            },
          },
        ];
      }
    }

    if (result.notes) next.notes = result.notes;
    for (const flag of result.offStandard ?? []) {
      notes.push(`${room.label}: an unusual ${flag}, worth checking.`);
    }
    for (const why of result.dropped ?? []) {
      notes.push(`${room.label}: dimensions not used - ${why}.`);
    }

    spec.rooms[room.id] = next;
    read++;
    onRoom?.(room.id, next);
  };

  for (let i = 0; i < withPhotos.length; i += BATCH) {
    const batch = withPhotos.slice(i, i + BATCH);
    onProgress?.({ room: batch[0]?.label ?? "", done, total });
    await Promise.all(batch.map((room) => one(room).catch(() => undefined)));
    done += batch.length;
    onProgress?.({ room: batch[batch.length - 1]?.label ?? "", done, total });
  }

  /**
   * And then reason about the rest.
   *
   * This is the half that makes a partly-photographed house cohere. The read
   * rooms are the evidence; the inference takes the conventions out of them -
   * one skirting, one trim colour, one ceiling height a storey, one oak - and
   * carries them to the landing, the second bathroom and the box room that no
   * photograph ever reached.
   */
  const inference = inferHouse(property.plan, spec);
  notes.push(...inference.conventions);

  return {
    spec: inference.spec,
    read,
    unseen: rooms.length - read,
    notes,
  };
}
