import type { SunState } from "@/lib/model/sun";

/**
 * The atmosphere, as the numbers three's analytic sky wants.
 *
 * The background behind a sited house was one flat colour - the horizon,
 * lifted toward white - and a flat backdrop is the first thing that says
 * "model" about a picture of a building. The analytic sky is a scattering
 * model with a sun in it: blue overhead, pale at the horizon, warm and hazy
 * when the sun is low, and the disc where the shadows say the sun is.
 *
 * Kept pure so it can be checked without a renderer: dawn hazier than noon,
 * the sun where `sunState` put it.
 */
export type SkyUniforms = {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  /** Unit vector toward the sun, in world axes. */
  sunPosition: [number, number, number];
};

export function skyUniformsFor(sun: SunState): SkyUniforms {
  // `day` is 0 at the horizon and 1 once the sun is 30 degrees up. Haze and
  // scattering both fall as it climbs: a low sun through a thick slice of
  // air is what makes a dawn orange, and the same numbers at noon would make
  // a foggy afternoon.
  const low = 1 - Math.max(0, Math.min(1, sun.day));
  const [x, y, z] = sun.direction;
  const length = Math.hypot(x, y, z) || 1;
  return {
    turbidity: 2.5 + 5.5 * low,
    rayleigh: 1.1 + 2.2 * low,
    mieCoefficient: 0.004 + 0.012 * low,
    mieDirectionalG: 0.78,
    sunPosition: [x / length, y / length, z / length],
  };
}
