/**
 * Turning a height field into the maps a physically-based material wants.
 *
 * The surfaces in this house are drawn in code rather than shipped as images,
 * for the reasons `textures.ts` sets out. That gave every surface a colour and
 * nothing else: perfectly flat under any light, so a tile floor had no grout
 * depth and a carpet no pile. What was missing is not more colour, it is the
 * other three maps - and those can be derived, because the generator that draws
 * the colour also knows where the surface is high and low.
 *
 * The one rule that matters: **height is drawn separately from colour, never
 * inferred from it.** A dark stripe in oak is a stripe, not a groove; a pale
 * vein in marble is not a ridge. Reading brightness as elevation is the classic
 * mistake and it produces a surface that looks embossed rather than real.
 *
 * Everything here is pure and works on plain arrays, so it can be tested
 * without a browser. The canvas wrappers live in `textures.ts`.
 */

/** Height in 0..1, row-major, `size` by `size`. */
export type HeightField = { size: number; data: Float32Array };

const wrap = (v: number, n: number) => (v < 0 ? v + n : v >= n ? v - n : v);

/**
 * Sobel a height field into a tangent-space normal map, as RGBA bytes.
 *
 * Sampling wraps at the edges because every one of these textures repeats, and
 * clamping instead puts a visible seam along the tile boundary - a hard line of
 * flat shading exactly where the eye is already looking for a repeat.
 *
 * `strength` is the height range in the same units as one texel's width, which
 * is what makes it resolution-independent: the same value gives the same
 * apparent relief whether the map is 512 or 1024 across.
 */
export function normalBytes(field: HeightField, strength: number): Uint8ClampedArray {
  const { size, data } = field;
  const out = new Uint8ClampedArray(size * size * 4);
  const at = (x: number, y: number) => data[wrap(y, size) * size + wrap(x, size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sobel, which is a 3x3 gradient rather than a plain difference - it
      // averages across the neighbouring rows, so single-texel noise does not
      // become a spike of normal.
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);

      const dx = tl + 2 * l + bl - (tr + 2 * r + br);
      const dy = tl + 2 * t + tr - (bl + 2 * b + br);

      // The cross product of the two tangents, normalised. z is 1 before
      // scaling, so a flat field gives exactly (0, 0, 1) - straight up.
      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const length = Math.hypot(nx, ny, nz) || 1;
      nx /= length;
      ny /= length;

      const i = (y * size + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz / length) * 0.5 * 255 + 127.5;
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * Ambient occlusion, roughness and metalness packed into one texture's three
 * channels - the glTF "ORM" convention.
 *
 * One upload and one sampler instead of three, and three.js is happy to be
 * handed the same texture as `aoMap`, `roughnessMap` and `metalnessMap`
 * because it reads a different channel from each.
 *
 * AO is the crudest possible approximation - low ground is occluded - but at
 * this scale that is exactly right: it darkens grout lines, the gaps between
 * boards and the pile of a carpet, which is where a real surface goes dark.
 *
 * `roughVariance` is what stops a floor reading as a single sheet of plastic.
 * Even a uniform finish is not uniformly worn, and varying roughness a little
 * across a surface is more convincing than varying its colour.
 */
export function ormBytes(
  field: HeightField,
  { roughness, roughVariance = 0.12, metalness = 0, ao = 0.55 }: {
    roughness: number;
    roughVariance?: number;
    metalness?: number;
    ao?: number;
  },
): Uint8ClampedArray {
  const { size, data } = field;
  const out = new Uint8ClampedArray(size * size * 4);
  const metalByte = Math.round(metalness * 255);

  for (let i = 0; i < data.length; i++) {
    const h = data[i];
    // Occlusion from depth below the surface, eased so the very bottom of a
    // groove goes dark quickly and the broad middle stays open.
    const occluded = 1 - ao * Math.pow(1 - h, 1.6);
    // Low ground is also the worn ground, so it reads slightly rougher.
    const rough = roughness + roughVariance * (1 - h) - roughVariance * 0.5;

    const o = i * 4;
    out[o] = Math.max(0, Math.min(1, occluded)) * 255;
    out[o + 1] = Math.max(0, Math.min(1, rough)) * 255;
    out[o + 2] = metalByte;
    out[o + 3] = 255;
  }
  return out;
}

/** Read a canvas' luminance as a height field, for generators that draw one. */
export function heightFromImageData(pixels: Uint8ClampedArray, size: number): HeightField {
  const data = new Float32Array(size * size);
  for (let i = 0; i < data.length; i++) {
    // The height pass is drawn in greys, so any channel would do; averaging
    // costs nothing and survives a generator that reaches for a tinted grey.
    const o = i * 4;
    data[i] = (pixels[o] + pixels[o + 1] + pixels[o + 2]) / 765;
  }
  return { size, data };
}
