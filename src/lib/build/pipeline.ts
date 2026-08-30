"use client";

import { classifyPhotos } from "@/lib/listing/client";
import { refinePoses } from "@/lib/listing/pose";
import { DepthEstimator, type DepthProgress } from "@/lib/depth/client";
import { getMedia, mediaRef, putMedia, refToKey } from "@/lib/media-store";
import { placeNodesInRoom } from "@/lib/plan/autolayout";
import type { HouseSpec } from "@/lib/plan/describe";
import type { Plan, Property, TourNode } from "@/lib/schema";

/**
 * The steps between "here are some photographs" and "here is your house".
 *
 * Lifted out of the wizard page, which is the only reason it existed there:
 * `build()` grew to two hundred lines inside a component, so nothing else could
 * run any part of it. Adding photographs to a house that already exists needs
 * exactly these steps and none of the wizard around them.
 *
 * Each step is separately useful and separately skippable, because the callers
 * genuinely differ. A first build labels every photograph and lays out a house;
 * a later addition labels a handful and drops them into rooms that are already
 * there. What must not differ is *how* a photograph gets labelled, placed and
 * posed - so that lives here, once.
 */

export type BuildStep = { label: string; done: number; total: number };

/** A photograph on its way into a house, before it is a `TourNode`. */
export type BuildPhoto = {
  id: string;
  /** `idb:` reference into the media store. */
  ref: string;
  roomLabel: string | null;
  /** How sure the model was, when it was the model that decided. */
  guessed?: "high" | "low";
};

/** Room names to offer when the house has not been described. */
export const FALLBACK_ROOMS = [
  "Living Room", "Kitchen", "Dining Room", "Primary Bedroom", "Bedroom 2",
  "Bedroom 3", "Bathroom", "Hallway", "Entry", "Office", "Laundry", "Garage",
  "Outside",
];

/**
 * Which room is each photograph, and which rooms did it see into.
 *
 * The adjacency is the part worth not losing. A kitchen photograph showing a
 * dining table through an archway says those two rooms touch, and that is the
 * strongest signal available for making a generated plan resemble the actual
 * house. It comes free with the labelling and costs the user nothing.
 */
export async function labelPhotos<T extends BuildPhoto>(
  photos: T[],
  rooms: string[],
  onProgress?: (step: BuildStep) => void,
): Promise<{
  photos: T[];
  adjacency: Array<[string, string]>;
  labelled: number;
}> {
  const untagged = photos.filter((p) => !p.roomLabel);
  if (untagged.length === 0) return { photos, adjacency: [], labelled: 0 };

  const label = "Looking at your photos";
  onProgress?.({ label, done: 0, total: untagged.length });

  const blobs = (
    await Promise.all(
      untagged.map(async (photo) => {
        const blob = await getMedia(refToKey(photo.ref));
        return blob ? { id: photo.id, blob } : null;
      }),
    )
  ).filter(Boolean) as Array<{ id: string; blob: Blob }>;

  const assignments = await classifyPhotos(blobs, rooms, (done, total) =>
    onProgress?.({ label, done, total }),
  );

  const byId = new Map(assignments.map((a) => [a.id, a]));
  const next = photos.map((photo) => {
    const found = byId.get(photo.id);
    return found && !photo.roomLabel
      ? { ...photo, roomLabel: found.room, guessed: found.confidence }
      : photo;
  });

  const pairs = new Set<string>();
  for (const assignment of assignments) {
    for (const other of assignment.connectsTo ?? []) {
      if (other && other !== assignment.room) {
        pairs.add([assignment.room, other].sort().join("|"));
      }
    }
  }

  return {
    photos: next,
    adjacency: [...pairs].map((p) => p.split("|") as [string, string]),
    labelled: assignments.length,
  };
}

/** Room names to offer, from the description if there was one. */
export function roomHints(spec: HouseSpec | null): string[] {
  return spec ? spec.rooms.map((r) => r.label) : FALLBACK_ROOMS;
}

/**
 * Put labelled photographs into a plan's rooms.
 *
 * Exact names are matched first across every room, so a loose match can never
 * take photographs that had a perfect home.
 *
 * `existing` is what makes this usable twice. Standing spots are handed out
 * from a fixed list, so a second pass over a room that already has viewpoints
 * would put a new camera exactly on top of an old one; telling it what is
 * already there is what keeps a later addition from landing on the first build.
 */
export function placePhotos<T extends BuildPhoto>(
  plan: Plan,
  photos: T[],
  existing: TourNode[] = [],
): { nodes: TourNode[]; unplaced: number } {
  const remaining = photos.filter((p) => p.roomLabel);
  const take = (predicate: (label: string) => boolean) => {
    const taken = remaining.filter((p) => predicate(p.roomLabel!));
    for (const photo of taken) remaining.splice(remaining.indexOf(photo), 1);
    return taken;
  };
  const key = (label: string) => label.toLowerCase().replace(/[^a-z]/g, "");

  const exact = new Map(plan.rooms.map((r) => [r.id, take((l) => l === r.label)]));
  const loose = new Map(
    plan.rooms.map((r) => [
      r.id,
      take((l) => key(l).startsWith(key(r.label)) || key(r.label).startsWith(key(l))),
    ]),
  );

  const nodes = plan.rooms.flatMap((room) =>
    placeNodesInRoom(
      room,
      [...(exact.get(room.id) ?? []), ...(loose.get(room.id) ?? [])].map((p) => ({
        id: p.id,
        photo: p.ref,
        depth: null,
      })),
      existing.filter((n) => n.roomId === room.id).map((n) => n.position),
    ),
  );

  return { nodes, unplaced: remaining.length };
}

/** Aim each camera from what its photograph actually shows. */
export async function posePhotos(
  plan: Plan,
  nodes: TourNode[],
  onProgress?: (step: BuildStep) => void,
): Promise<{ nodes: TourNode[]; refined: number }> {
  const label = "Placing the cameras";
  onProgress?.({ label, done: 0, total: nodes.length });
  try {
    const result = await refinePoses(plan, nodes, (done, total) =>
      onProgress?.({ label, done, total }),
    );
    return { nodes: result.nodes, refined: result.refined };
  } catch {
    // The corner heuristic is still usable, and is what every node already has.
    return { nodes, refined: 0 };
  }
}

/**
 * Depth maps, one photograph at a time, saving as each lands.
 *
 * Saving incrementally rather than at the end is what lets someone open the
 * tour while this is still running - and what stops a closed tab throwing away
 * twenty minutes of GPU time.
 */
export async function estimateDepth(
  estimator: DepthEstimator,
  property: Property,
  onProgress: (progress: DepthProgress) => void,
  onUpdate: (property: Property) => void,
): Promise<Property> {
  const jobs = (
    await Promise.all(
      property.nodes
        .filter((node) => !node.depth)
        .map(async (node) => {
          const room = property.plan.rooms.find((r) => r.id === node.roomId);
          const blob = room ? await getMedia(refToKey(node.photo)) : null;
          return room && blob ? { node, room, blob } : null;
        }),
    )
  ).filter(Boolean) as Array<{
    node: TourNode;
    room: Plan["rooms"][number];
    blob: Blob;
  }>;

  let working = property;
  await estimator.run(jobs, onProgress, async (nodeId, blob) => {
    const mediaKey = `${property.id}/${nodeId}/depth`;
    await putMedia(mediaKey, blob);
    working = {
      ...working,
      nodes: working.nodes.map((n) =>
        n.id === nodeId ? { ...n, depth: mediaRef(mediaKey) } : n,
      ),
    };
    onUpdate(working);
  });
  return working;
}
