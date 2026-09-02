import { type WallSolid, exteriorRuns } from "@/lib/model/walls";
import { boundsOf } from "@/lib/plan/geometry";

import { roomKind } from "@/lib/plan/room-kind";
import type { Plan, Vec2 } from "@/lib/schema";

/**
 * Where the windows go.
 *
 * Derived rather than stored, on the same principle as doorways: nobody should
 * have to place a window, the plan already says which walls face outside, and
 * deriving them means every tour ever built gets windows the moment this
 * improves.
 *
 * Windows do more for how a model reads than their size suggests. A blank
 * exterior wall looks like a warehouse; the same wall with a window looks like
 * a house, and from the dollhouse view they are what tells you which side of
 * the building you are looking at.
 */

export const SILL_HEIGHT = 0.9;
export const HEAD_HEIGHT = 2.1;
const MAX_WIDTH = 1.6;
const MIN_WALL_FOR_WINDOW = 1.8;

export type ModelWindow = {
  center: Vec2;
  width: number;
  sill: number;
  head: number;
  thickness: number;
  angleDeg: number;
};

/**
 * Which room a point on an exterior wall belongs to.
 *
 * Needed because whether a wall gets a window depends on what is behind it - a
 * garage or a stairwell should not sprout one - and a wall solid does not carry
 * its room.
 */
function roomAt(plan: Plan, level: number, point: Vec2): string | null {
  for (const room of plan.rooms) {
    if (room.level !== level) continue;
    const b = boundsOf(room.polygon);
    // Generous, because an exterior wall sits half its thickness outside the
    // room it belongs to.
    if (
      point[0] > b.x0 - 0.3 && point[0] < b.x1 + 0.3 &&
      point[1] > b.y0 - 0.3 && point[1] < b.y1 + 0.3
    ) {
      return room.label;
    }
  }
  return null;
}

const NO_WINDOWS = new Set(["closet", "stairs", "garage", "outside"]);

export function windowsForLevel(plan: Plan, level: number): ModelWindow[] {
  const windows: ModelWindow[] = [];

  for (const wall of exteriorRuns(plan, level)) {
    if (wall.length < MIN_WALL_FOR_WINDOW) continue;

    const label = roomAt(plan, level, wall.center);
    if (label && NO_WINDOWS.has(roomKind(label))) continue;

    // One window, centred. Several evenly spaced would look better on a long
    // elevation and worse everywhere else, and a wrong-looking window is more
    // noticeable than a missing one.
    windows.push({
      center: wall.center,
      width: Math.min(MAX_WIDTH, wall.length * 0.5),
      sill: SILL_HEIGHT,
      head: HEAD_HEIGHT,
      // Slightly proud of the wall so the reveal is visible from both sides.
      thickness: wall.thickness + 0.02,
      angleDeg: wall.angleDeg,
    });
  }

  return windows;
}

/**
 * Wall pieces that remain around a window: below the sill, and above the head.
 *
 * The window is cut from the wall by drawing the wall in pieces rather than by
 * boolean subtraction - constructive solid geometry on every wall would be far
 * more machinery than a rectangular hole in a rectangular wall deserves.
 */
export function wallPiecesAround(wall: WallSolid, window: ModelWindow): WallSolid[] {
  const axis = wall.angleDeg === 0 ? 0 : 1;
  const along = wall.center[axis];
  const windowAlong = window.center[axis];

  const left = { from: along - wall.length / 2, to: windowAlong - window.width / 2 };
  const right = { from: windowAlong + window.width / 2, to: along + wall.length / 2 };

  const piece = (from: number, to: number, base: number, height: number): WallSolid => {
    const mid = (from + to) / 2;
    return {
      ...wall,
      center: axis === 0 ? [mid, wall.center[1]] : [wall.center[0], mid],
      length: to - from,
      base,
      height,
    };
  };

  const pieces: WallSolid[] = [];
  if (left.to - left.from > 1e-3) pieces.push(piece(left.from, left.to, 0, wall.height));
  if (right.to - right.from > 1e-3) pieces.push(piece(right.from, right.to, 0, wall.height));

  // Under the sill and over the head, spanning the window's width.
  const from = windowAlong - window.width / 2;
  const to = windowAlong + window.width / 2;
  pieces.push(piece(from, to, 0, window.sill));
  pieces.push(piece(from, to, window.head, Math.max(wall.height - window.head, 0.01)));

  return pieces;
}
