/// <reference lib="webworker" />
import { RawImage, pipeline, type DepthEstimationPipeline } from "@huggingface/transformers";

/**
 * Monocular depth, in the browser.
 *
 * This is what removes a Colab notebook from the critical path. Asking someone
 * to open a Python notebook, install CUDA wheels and upload their photos is a
 * hard stop for most people, and it is the only reason the tour needed a GPU
 * they do not have. Depth Anything V2 Small runs here instead - on WebGPU where
 * available, WASM otherwise - so the whole product is a web page.
 *
 * Small is also the only variant licensed Apache-2.0; Base, Large and Giant are
 * CC-BY-NC and cannot be used commercially. That is a licence constraint, not a
 * performance trade-off, and it is not negotiable.
 *
 * Runs in a worker because WASM inference blocks whatever thread it is on, and
 * a frozen page during a 25-photo import looks exactly like a crash.
 */

const MODEL_ID = "onnx-community/depth-anything-v2-small";

let estimator: DepthEstimationPipeline | null = null;

async function getEstimator(): Promise<DepthEstimationPipeline> {
  if (estimator) return estimator;

  // WebGPU is several times faster but is still absent or broken in enough
  // browsers that it cannot be required. WASM is the guarantee.
  try {
    estimator = (await pipeline("depth-estimation", MODEL_ID, {
      device: "webgpu",
      dtype: "fp16",
      progress_callback: (p: unknown) => postMessage({ type: "progress", payload: p }),
    })) as DepthEstimationPipeline;
    postMessage({ type: "backend", backend: "webgpu" });
  } catch {
    estimator = (await pipeline("depth-estimation", MODEL_ID, {
      device: "wasm",
      dtype: "q8",
      progress_callback: (p: unknown) => postMessage({ type: "progress", payload: p }),
    })) as DepthEstimationPipeline;
    postMessage({ type: "backend", backend: "wasm" });
  }

  return estimator;
}

/**
 * Turn the model's relative output into metres, using the room it was shot in.
 *
 * Depth Anything predicts *relative* inverse depth - it knows the sofa is
 * nearer than the wall, not how far either is. On its own that is unusable for
 * a shell placed in a metric world. But the floor plan already says how big the
 * room is, so the far anchor is simply the distance to its most distant corner.
 * This is the synergy the whole design rests on: the plan supplies the scale
 * that single-image depth cannot.
 *
 * Interpolation happens in disparity space, not depth space, because that is
 * what the model's output actually is - and mixing the two bends flat walls.
 */
function toMetres(
  relative: Float32Array,
  nearM: number,
  farM: number,
): Float32Array {
  let min = Infinity;
  let max = -Infinity;
  for (const v of relative) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;

  const nearDisparity = 1 / Math.max(nearM, 0.05);
  const farDisparity = 1 / Math.max(farM, nearM + 0.1);

  const out = new Float32Array(relative.length);
  for (let i = 0; i < relative.length; i++) {
    // 1 = nearest. A degenerate flat prediction collapses to the far plane,
    // which renders as a plain backdrop rather than as garbage geometry.
    const t = span > 1e-9 ? (relative[i] - min) / span : 0;
    const disparity = farDisparity + t * (nearDisparity - farDisparity);
    out[i] = 1 / disparity;
  }
  return out;
}

/**
 * Pack metres into RGB as 24-bit millimetres - the format the shell shader
 * decodes. A 16-bit PNG would be the obvious container, but browsers drop one
 * to 8 bits per channel on the way into a texture, destroying the precision.
 */
function packToImageData(depth: Float32Array, width: number, height: number): ImageData {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < depth.length; i++) {
    const mm = Math.max(0, Math.min(0xffffff, Math.round(depth[i] * 1000)));
    const o = i * 4;
    rgba[o] = (mm >> 16) & 0xff;
    rgba[o + 1] = (mm >> 8) & 0xff;
    rgba[o + 2] = mm & 0xff;
    rgba[o + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

export type DepthRequest = {
  type: "estimate";
  id: string;
  blob: Blob;
  nearM: number;
  farM: number;
};

self.onmessage = async (event: MessageEvent<DepthRequest>) => {
  const request = event.data;
  if (request?.type !== "estimate") return;

  try {
    const estimate = await getEstimator();
    const image = await RawImage.fromBlob(request.blob);
    const { predicted_depth } = await estimate(image);

    const dims = predicted_depth.dims;
    const height = dims[dims.length - 2];
    const width = dims[dims.length - 1];
    const relative = predicted_depth.data as Float32Array;

    const metres = toMetres(relative, request.nearM, request.farM);
    const imageData = packToImageData(metres, width, height);

    // PNG, because the packing is only lossless in a lossless container.
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context in worker");
    ctx.putImageData(imageData, 0, 0);
    const png = await canvas.convertToBlob({ type: "image/png" });

    postMessage({ type: "done", id: request.id, blob: png, width, height });
  } catch (error) {
    postMessage({
      type: "error",
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
