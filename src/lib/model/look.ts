/**
 * Looking around on foot, without a pointer lock.
 *
 * A drag turns the head: right to look right, down to look down, with the
 * pitch stopped short of straight up and down so the horizon never flips.
 * Letting go leaves a little momentum that dies away, which is what makes a
 * turn feel like a turn rather than a stop. Pure, so the numbers can be
 * checked without a browser.
 */

export type Look = { yaw: number; pitch: number };

/** How far up or down the head turns, in radians. */
export const PITCH_LIMIT = 1.2;

/** Radians per pixel of drag. */
export const DRAG_SENSITIVITY = 0.0045;

/** How fast a released turn dies away, per second. */
export const LOOK_DAMPING = 6;

export function turnBy(look: Look, dxPixels: number, dyPixels: number, sensitivity = DRAG_SENSITIVITY): Look {
  // three.js turns the camera left as `rotation.y` grows, so dragging right
  // - meaning "look right" - takes yaw down.
  const yaw = look.yaw - dxPixels * sensitivity;
  const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, look.pitch - dyPixels * sensitivity));
  return { yaw, pitch };
}

/** A released drag's remaining turn, after `dt` seconds. */
export function damped(velocity: number, dt: number, damping = LOOK_DAMPING): number {
  const v = velocity * Math.exp(-damping * dt);
  return Math.abs(v) < 1e-4 ? 0 : v;
}

/** Which way the feet go for a yaw, in plan metres: the same convention the walker uses. */
export function headingVector(yaw: number): [number, number] {
  return [Math.sin(yaw), Math.cos(yaw)];
}

/** Yaw that faces from one plan point toward another. */
export function yawTowards(from: [number, number], to: [number, number]): number {
  return Math.atan2(to[0] - from[0], to[1] - from[1]);
}
