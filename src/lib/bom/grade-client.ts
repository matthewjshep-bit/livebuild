"use client";

import { type ConditionMap, type Grade, elementsFor } from "@/lib/bom/condition";
import { getMedia, isManagedRef, refToKey } from "@/lib/media-store";
import { roomKind } from "@/lib/plan/room-kind";
import type { Property } from "@/lib/schema";

/**
 * Grade every room from its own photos.
 *
 * One request per room rather than one for the house: a room is graded against
 * its own pictures, and mixing them would invite the kitchen's condition to
 * colour the bathroom's. Rooms with no photos are not sent at all - the answer
 * is `not_visible` and it does not need asking for.
 */

const GRADE_EDGE = 900;
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

export async function gradeProperty(
  property: Property,
  onProgress?: (progress: GradeProgress) => void,
): Promise<{ condition: ConditionMap; graded: number; unseen: number }> {
  const condition: ConditionMap = {};
  let graded = 0;
  let unseen = 0;

  const rooms = property.plan.rooms;

  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];
    onProgress?.({ room: room.label, done: i, total: rooms.length });

    const elements = elementsFor(roomKind(room.label));
    if (elements.length === 0) continue;

    const nodes = property.nodes.filter((n) => n.roomId === room.id).slice(0, MAX_PER_ROOM);
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

    if (photos.length === 0) {
      unseen += 1;
      // Left absent rather than written as not_visible: the BOM already treats
      // a missing grade that way, and an empty map is what "never graded" looks
      // like.
      continue;
    }

    try {
      const response = await fetch("/api/condition", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room: room.label, elements, photos }),
      });
      if (!response.ok) continue;

      const data = await response.json();
      const entry: Record<string, Grade> = {};
      for (const item of data.grades ?? []) {
        if (elements.includes(item.element)) entry[item.element] = item.grade;
      }
      if (Object.keys(entry).length > 0) {
        condition[room.id] = entry as ConditionMap[string];
        graded += 1;
      }
    } catch {
      // One room failing leaves it ungraded, which the BOM shows as unknown.
    }
  }

  onProgress?.({ room: "", done: rooms.length, total: rooms.length });
  return { condition, graded, unseen };
}
