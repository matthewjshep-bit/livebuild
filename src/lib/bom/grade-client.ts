"use client";

import {
  type ConditionMap,
  EXTERIOR_ELEMENTS,
  type Grade,
  type HouseCondition,
  elementsFor,
} from "@/lib/bom/condition";
import { getMedia, isManagedRef, refToKey } from "@/lib/media-store";
import { roomKind } from "@/lib/plan/room-kind";
import type { Property } from "@/lib/schema";
import { policyFor } from "@/lib/ai/policy";

/**
 * Grade every room from its own photos.
 *
 * One request per room rather than one for the house: a room is graded against
 * its own pictures, and mixing them would invite the kitchen's condition to
 * colour the bathroom's. Rooms with no photos are not sent at all - the answer
 * is `not_visible` and it does not need asking for.
 */

const GRADE_EDGE = policyFor("condition").imageEdge;
const MAX_PER_ROOM = 4;

async function thumbnail(blob: Blob): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, GRADE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    // Higher quality than the classification pass uses. Telling a chipped tile
    // from a clean one is exactly the sort of detail JPEG throws away first.
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return null;
  }
}

export type GradeProgress = { room: string; done: number; total: number };

/**
 * How many rooms to grade at once.
 *
 * One at a time was right when a person pressed a button and watched, and wrong
 * once this runs on its own after every build: a dozen rooms sequentially at
 * high effort is minutes of a house sitting there uncosted. Rooms are graded
 * independently by design - the comment above says why mixing them is not an
 * option - so widening costs nothing in accuracy and is the same shape
 * `refinePoses` already uses.
 */
const GRADE_BATCH = 3;

/** The photographs for one room, as data URLs, or an empty list if it has none. */
async function photosForRoom(property: Property, roomId: string): Promise<string[]> {
  const nodes = property.nodes.filter((n) => n.roomId === roomId).slice(0, MAX_PER_ROOM);
  const photos: string[] = [];
  for (const node of nodes) {
    // Locally-built tours store their photos; bundled samples reference files.
    // Handling both means the demo house can be costed like any other, which
    // is the first thing anyone will try.
    const blob = isManagedRef(node.photo)
      ? await getMedia(refToKey(node.photo))
      : await fetch(node.photo)
          .then((r) => (r.ok ? r.blob() : null))
          .catch(() => null);
    if (!blob) continue;
    const dataUrl = await thumbnail(blob);
    if (dataUrl) photos.push(dataUrl);
  }
  return photos;
}

export async function gradeProperty(
  property: Property,
  onProgress?: (progress: GradeProgress) => void,
  /**
   * Called as each room's grades arrive.
   *
   * Without it this returns everything at the end, which is fine for a button
   * somebody is watching and not fine for a pass that runs on its own for two
   * minutes - a closed tab would throw all of it away. Saving each room as it
   * lands is what depth estimation already does, for the same reason.
   */
  onRoom?: (roomId: string, grades: Record<string, Grade>) => void,
): Promise<{ condition: ConditionMap; graded: number; unseen: number }> {
  const condition: ConditionMap = {};
  let graded = 0;
  let unseen = 0;
  let done = 0;

  const rooms = property.plan.rooms.filter(
    (room) => elementsFor(roomKind(room.label)).length > 0,
  );

  for (let i = 0; i < rooms.length; i += GRADE_BATCH) {
    const batch = rooms.slice(i, i + GRADE_BATCH);
    onProgress?.({ room: batch[0]?.label ?? "", done, total: rooms.length });

    await Promise.all(
      batch.map(async (room) => {
        const elements = elementsFor(roomKind(room.label));
        const photos = await photosForRoom(property, room.id);

        if (photos.length === 0) {
          unseen += 1;
          // Left absent rather than written as not_visible: the BOM already
          // treats a missing grade that way, and an empty map is what "never
          // graded" looks like.
          return;
        }

        try {
          const response = await fetch("/api/condition", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ room: room.label, elements, photos }),
          });
          if (!response.ok) return;

          const data = await response.json();
          const entry: Record<string, Grade> = {};
          for (const item of data.grades ?? []) {
            if (elements.includes(item.element)) entry[item.element] = item.grade;
          }
          if (Object.keys(entry).length > 0) {
            condition[room.id] = entry as ConditionMap[string];
            graded += 1;
            onRoom?.(room.id, entry);
          }
        } catch {
          // One room failing leaves it ungraded, which the BOM shows as unknown.
        }
      }),
    );

    done = Math.min(i + GRADE_BATCH, rooms.length);
  }

  onProgress?.({ room: "", done: rooms.length, total: rooms.length });
  return { condition, graded, unseen };
}

/** How many exterior shots to send. A listing leads with several of the front. */
const MAX_EXTERIOR = 5;

/**
 * Grade the building itself from the listing's exterior photographs.
 *
 * Without this the whole-house section - roof, siding, windows, landscaping -
 * is permanently "not seen" and costs nothing, which drags the total below the
 * ranges it is checked against. And the photographs to fix it are already
 * there: a listing leads with the front elevation, and the classifier has
 * already set those aside as `Outside`.
 *
 * The systems are deliberately not graded. A furnace does not appear in a
 * photograph of a house, and a guess at one would be indistinguishable from an
 * observation once it was stored.
 */
export async function gradeExterior(
  property: Property,
): Promise<{ houseCondition: HouseCondition; photos: number }> {
  const outsideRooms = new Set(
    property.plan.rooms.filter((r) => roomKind(r.label) === "outside").map((r) => r.id),
  );
  const nodes = property.nodes
    .filter((n) => outsideRooms.has(n.roomId))
    .slice(0, MAX_EXTERIOR);

  const photos: string[] = [];
  for (const node of nodes) {
    const blob = isManagedRef(node.photo)
      ? await getMedia(refToKey(node.photo))
      : await fetch(node.photo)
          .then((r) => (r.ok ? r.blob() : null))
          .catch(() => null);
    if (!blob) continue;
    const dataUrl = await thumbnail(blob);
    if (dataUrl) photos.push(dataUrl);
  }

  if (photos.length === 0) return { houseCondition: {}, photos: 0 };

  try {
    const response = await fetch("/api/condition", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "house",
        room: "exterior",
        elements: [...EXTERIOR_ELEMENTS],
        photos,
      }),
    });
    if (!response.ok) return { houseCondition: {}, photos: photos.length };

    const data = await response.json();
    const allowed = new Set<string>(EXTERIOR_ELEMENTS);
    const houseCondition: HouseCondition = {};
    for (const item of data.grades ?? []) {
      if (allowed.has(item.element)) {
        houseCondition[item.element as keyof HouseCondition] = item.grade as Grade;
      }
    }
    return { houseCondition, photos: photos.length };
  } catch {
    return { houseCondition: {}, photos: photos.length };
  }
}
