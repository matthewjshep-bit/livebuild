import * as THREE from "three";

/**
 * A still of the model, taken from where a photograph was taken.
 *
 * This is what makes checking the replica against its evidence possible at all:
 * put the camera exactly where the lens was, render, and the two images are of
 * the same view of the same room, so a difference between them is a difference
 * in the building rather than in the vantage point.
 *
 * `TourNode` has carried `position`, `heading`, `pitch`, `fovDeg` and
 * `eyeHeight` since the photographs came off the model, unread by anything.
 * This is what they were kept for.
 *
 * Five details, each of which fails quietly if skipped.
 */

/**
 * Vertical field of view from a horizontal one.
 *
 * `/api/pose` reports the lens' *horizontal* angle, because that is what you
 * can judge from a photograph. three.js' `fov` is *vertical*. Passing one for
 * the other scales the entire comparison, and the render still looks like a
 * plausible photograph of a plausible room - so the error would show up as the
 * verifier confidently correcting every dimension in the house by a constant
 * factor.
 */
export function verticalFov(horizontalDeg: number, aspect: number): number {
  const h = (horizontalDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(h / 2) / aspect) * 180) / Math.PI;
}

export type CapturePose = {
  /** World position of the lens. */
  position: [number, number, number];
  /** Compass heading in degrees, as `TourNode` stores it. */
  headingDeg: number;
  pitchDeg: number;
  /** The lens' horizontal angle, as `/api/pose` reports it. */
  fovDeg: number;
};

export type CaptureSize = { width: number; height: number };

const DEFAULT_SIZE: CaptureSize = { width: 1024, height: 768 };

export function captureFromPose(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  pose: CapturePose,
  size: CaptureSize = DEFAULT_SIZE,
): string | null {
  const aspect = size.width / size.height;

  const camera = new THREE.PerspectiveCamera(
    verticalFov(pose.fovDeg, aspect),
    aspect,
    0.05,
    200,
  );
  camera.position.set(...pose.position);
  // The camera looks down -Z while headings are measured off +Z, so a bearing
  // becomes a rotation by adding half a turn. Same convention the viewer used
  // when it still stood the camera inside photographs.
  camera.setRotationFromEuler(
    new THREE.Euler(
      (pose.pitchDeg * Math.PI) / 180,
      (pose.headingDeg * Math.PI) / 180 + Math.PI,
      0,
      "YXZ",
    ),
  );
  camera.updateMatrixWorld();

  const target = new THREE.WebGLRenderTarget(size.width, size.height, {
    /**
     * Eight-bit, not half-float.
     *
     * `readRenderTargetPixels` reads according to the target's own type, so a
     * half-float target has to be read into a `Float32Array`; handing it a
     * `Uint8Array` does not error, it simply returns zeros - a perfectly
     * well-formed, completely black JPEG. There is nothing to gain from the
     * extra precision either, because tone mapping has already run by the time
     * these pixels exist and the result is about to become a JPEG.
     */
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    // The visible canvas gets its antialiasing from SMAA in the effect stack,
    // which this render bypasses entirely. Multisampling is the replacement.
    samples: 4,
  });

  const previousTarget = gl.getRenderTarget();
  const previousToneMapping = gl.toneMapping;
  const previousExposure = gl.toneMappingExposure;

  try {
    /**
     * Tone mapping, restored for the length of the capture.
     *
     * The renderer's own is deliberately off - the filmic curve was moved into
     * the effect stack so it runs after bloom rather than before it. A capture
     * that goes straight to a render target never touches that stack, so
     * without this it comes out linear and washed out, and the verifier reads
     * the difference as the room being wrongly lit and sets about correcting
     * finishes to compensate. That is precisely the failure that would make a
     * correction loop destructive rather than useful.
     */
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.0;

    gl.setRenderTarget(target);
    gl.render(scene, camera);

    const pixels = new Uint8Array(size.width * size.height * 4);
    gl.readRenderTargetPixels(target, 0, 0, size.width, size.height, pixels);

    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // GL's origin is bottom-left and a canvas' is top-left, so the rows come
    // back upside down. An inverted render compared against an upright
    // photograph is not obviously inverted - it is just wrong about everything.
    const image = ctx.createImageData(size.width, size.height);
    const rowBytes = size.width * 4;
    for (let y = 0; y < size.height; y++) {
      const from = (size.height - 1 - y) * rowBytes;
      image.data.set(pixels.subarray(from, from + rowBytes), y * rowBytes);
    }
    ctx.putImageData(image, 0, 0);

    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return null;
  } finally {
    gl.setRenderTarget(previousTarget);
    gl.toneMapping = previousToneMapping;
    gl.toneMappingExposure = previousExposure;
    target.dispose();
  }
}

/**
 * How alike two images are, structurally.
 *
 * A second opinion the loop can trust, and the reason it exists is that a
 * model's own score of its own work drifts. This measures whether the *lines*
 * are in the same places, which is exactly what geometric correctness is and
 * exactly what survives the gulf between a photograph and a flat-shaded render.
 *
 * The absolute number is low - 0.2 to 0.4 against a real photograph is normal
 * and means nothing. It is only ever read as a delta on the same pair of images
 * with the model changed in between: moving a run of units to where it really
 * is moves edges into alignment, and that is an easy signal even when the
 * overall similarity stays poor. Gate on the change, never on the level.
 */
export function structuralScore(a: ImageData, b: ImageData): number {
  if (a.width !== b.width || a.height !== b.height) return 0;

  const gradient = (img: ImageData) => {
    const { width, height, data } = img;
    const out = new Float32Array(width * height);
    const lum = (i: number) =>
      (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        const gx = lum(i + 1) - lum(i - 1);
        const gy = lum(i + width) - lum(i - width);
        out[i] = Math.hypot(gx, gy);
      }
    }
    return out;
  };

  const ga = gradient(a);
  const gb = gradient(b);

  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < ga.length; i++) {
    meanA += ga[i];
    meanB += gb[i];
  }
  meanA /= ga.length;
  meanB /= gb.length;

  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < ga.length; i++) {
    const da = ga[i] - meanA;
    const db = gb[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }

  const denominator = Math.sqrt(varA * varB);
  if (denominator < 1e-9) return 0;
  return Math.max(0, Math.min(1, cov / denominator));
}
