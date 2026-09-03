/**
 * Tinting a scanned surface to a read colour.
 *
 * A scan comes in its own colour - the oak Poly Haven photographed, not the
 * oak in this house - and the reader has said what colour this house's floor
 * is. Multiplying the scan by that colour darkens it by the scan's own shade
 * on top; what is wanted is the scan's grain at the read colour. So the
 * multiplier is the read colour over the scan's average, per channel, and the
 * result averages to the read colour whatever the scan started as.
 *
 * Done in linear light, because that is where the material multiplies.
 */
export type Rgb = [number, number, number];

export function parseHex(hex: string | null | undefined): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** The most a channel is pushed. Beyond this a dark scan tinted pale is noise. */
const MAX_GAIN = 3;
const MIN_GAIN = 0.05;

/**
 * The linear multiplier that brings a scan whose average (sRGB) is `mean` to
 * the colour `tone`. White when there is no tone - the scan as it is.
 */
export function tintFor(mean: Rgb, tone: string | null | undefined): Rgb {
  const target = parseHex(tone);
  if (!target) return [1, 1, 1];
  return [0, 1, 2].map((i) => {
    const m = srgbToLinear(mean[i]);
    const t = srgbToLinear(target[i]);
    return Math.max(MIN_GAIN, Math.min(MAX_GAIN, t / Math.max(m, 1e-3)));
  }) as Rgb;
}

/** The average colour of a run of sRGB bytes, RGBA, as 0..1. */
export function meanOfPixels(data: Uint8ClampedArray | Uint8Array): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  const count = Math.floor(data.length / 4);
  for (let i = 0; i < count; i++) {
    r += data[i * 4];
    g += data[i * 4 + 1];
    b += data[i * 4 + 2];
  }
  const n = Math.max(1, count) * 255;
  return [r / n, g / n, b / n];
}
