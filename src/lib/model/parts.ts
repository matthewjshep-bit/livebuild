import type { Vec2 } from "@/lib/schema";

/**
 * An oriented box in world terms: plan x, height, plan y at the centre; width
 * along the wall, height, and depth across it; turned by `angleDeg` about the
 * vertical the way a wall is. It is what every assembly here is made of, and
 * `Model.tsx` turns one into geometry with `boxGeometry(center, size, angle)`.
 */
export type Part = {
  center: [number, number, number];
  size: [number, number, number];
  angleDeg: number;
  colour: string;
  /** What it is, for the readout and for picking a material. */
  part: string;
};

/** A part placed against a wall: `along` metres along it, `out` metres outward, `y` up. */
export function placed(
  at: Vec2,
  along: Vec2,
  outward: Vec2,
  a: number,
  out: number,
  y: number,
  size: [number, number, number],
  angleDeg: number,
  colour: string,
  part: string,
): Part {
  return {
    center: [at[0] + along[0] * a + outward[0] * out, y, at[1] + along[1] * a + outward[1] * out],
    size,
    angleDeg,
    colour,
    part,
  };
}

/** The unit direction along a wall at `angleDeg`, in plan. */
export function alongOf(angleDeg: number): Vec2 {
  const r = (angleDeg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}
