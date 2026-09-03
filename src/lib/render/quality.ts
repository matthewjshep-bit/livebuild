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
 *
 * The tiers are one table now. "Best" and "Balanced" used to differ in name
 * only - the same shadow map, the same half-resolution occlusion, the same
 * effect stack - so the top of the range was a promise nothing kept. Each row
 * says what its tier actually buys.
 */
export type Quality = "low" | "medium" | "high";

export const QUALITY_LABEL: Record<Quality, string> = {
  low: "Fast",
  medium: "Balanced",
  high: "Best",
};

export type Tier = {
  /** Upper bound on device pixel ratio. Retina at full rate is four times the work. */
  dpr: number;
  /** Shadow map edge, in texels. The sun is the only light casting one. */
  shadowSize: number;
  /** Percentage-closer soft shadows: an edge that softens with distance from what casts it. */
  softShadows: boolean;
  /** Screen-space occlusion, and at what resolution. */
  occlusion: "none" | "half" | "full";
  bloom: boolean;
  /** The lens: a darkened edge to the frame. */
  vignette: boolean;
  /** A light grade: a little contrast and saturation on top of the tone curve. */
  grade: boolean;
  /** Depth of field at eye level, focused where the camera looks. */
  depthOfField: boolean;
  /** Whether bundled texture sets are loaded at all, or the procedural ones stay. */
  assets: boolean;
};

export const TIERS: Record<Quality, Tier> = {
  low: {
    dpr: 1.5,
    shadowSize: 1024,
    softShadows: false,
    occlusion: "none",
    bloom: false,
    vignette: false,
    grade: false,
    depthOfField: false,
    assets: false,
  },
  medium: {
    dpr: 2,
    shadowSize: 2048,
    softShadows: false,
    occlusion: "half",
    bloom: true,
    vignette: true,
    grade: true,
    depthOfField: false,
    assets: true,
  },
  high: {
    dpr: 2,
    shadowSize: 4096,
    softShadows: true,
    occlusion: "full",
    bloom: true,
    vignette: true,
    grade: true,
    depthOfField: true,
    assets: true,
  },
};

export const SHADOW_SIZE: Record<Quality, number> = {
  low: TIERS.low.shadowSize,
  medium: TIERS.medium.shadowSize,
  high: TIERS.high.shadowSize,
};

export const MAX_DPR: Record<Quality, number> = {
  low: TIERS.low.dpr,
  medium: TIERS.medium.dpr,
  high: TIERS.high.dpr,
};

/**
 * A renderer that is a CPU pretending to be a GPU.
 *
 * Headless browsers, virtual machines and some locked-down desktops draw with
 * SwiftShader or Mesa's llvmpipe, and report a dozen cores and plenty of
 * memory while doing it - so the core count says "high" and the frame takes
 * a quarter of a second. The renderer string is the one thing that tells.
 */
export function isSoftwareRenderer(renderer: string | null | undefined): boolean {
  return /swiftshader|llvmpipe|softpipe|software|mesa offscreen/i.test(renderer ?? "");
}

/** The GPU's name, as far as the browser will say. */
export function rendererName(gl: WebGLRenderingContext | WebGL2RenderingContext): string | null {
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const value = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return value ? String(value) : null;
  } catch {
    return null;
  }
}

const ORDER: Quality[] = ["low", "medium", "high"];

/**
 * One tier down or up from the current one, never above what the machine
 * was judged able to run: the performance monitor steps down when frames
 * are dropped and back up when they recover, and "recover" must not climb
 * past the tier the device detected as its own.
 */
export function steppedQuality(current: Quality, delta: -1 | 1, ceiling: Quality): Quality {
  const top = ORDER.indexOf(ceiling);
  const next = ORDER.indexOf(current) + delta;
  return ORDER[Math.max(0, Math.min(top, next))];
}

export function detectQuality(renderer?: string | null): Quality {
  if (typeof navigator === "undefined") return "medium";

  // Coarse pointer plus a narrow screen is a phone or a tablet, whatever it
  // claims about its cores - and a recent phone reports eight of them.
  const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const narrow = typeof window !== "undefined" && window.innerWidth < 900;
  if (touch && narrow) return "low";

  // A CPU drawing pixels, however many cores it claims. It cannot afford the
  // scans - uploading them stalls the frame for seconds - nor the occlusion
  // pass, and the bottom tier is what it can actually run.
  if (isSoftwareRenderer(renderer)) return "low";
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  if (cores <= 4 || memory <= 4) return "medium";
  return "high";
}
