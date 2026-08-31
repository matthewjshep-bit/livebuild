/**
 * How much rendering this machine can afford.
 *
 * A house has to open on a phone as well as on a desktop, and the difference
 * between those is not a few percent - it is whether a screen-space occlusion
 * pass at half resolution is free or is the whole frame budget. Rather than
 * measuring frame times and thrashing between settings, this decides once from
 * what the device says about itself, and the answer is overridable because
 * every heuristic of this kind is wrong for somebody.
 *
 * Deliberately crude. The only decision it drives is which effects mount, and
 * being one tier too conservative costs a little polish while being one tier
 * too ambitious costs a slideshow.
 */
export type Quality = "low" | "medium" | "high";

export const QUALITY_LABEL: Record<Quality, string> = {
  low: "Fast",
  medium: "Balanced",
  high: "Best",
};

export function detectQuality(): Quality {
  if (typeof navigator === "undefined") return "medium";

  // Coarse pointer plus a narrow screen is a phone or a tablet, whatever it
  // claims about its cores - and a recent phone reports eight of them.
  const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const narrow = typeof window !== "undefined" && window.innerWidth < 900;
  if (touch && narrow) return "low";

  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  if (cores <= 4 || memory <= 4) return "medium";
  return "high";
}

/** Shadow map edge, in texels. The sun is the only light casting one. */
export const SHADOW_SIZE: Record<Quality, number> = {
  low: 1024,
  medium: 2048,
  high: 2048,
};

/** Upper bound on device pixel ratio. Retina at full rate is four times the work. */
export const MAX_DPR: Record<Quality, number> = {
  low: 1.5,
  medium: 2,
  high: 2,
};
