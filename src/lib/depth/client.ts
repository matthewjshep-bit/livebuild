"use client";

import { boundsOf } from "@/lib/plan/autolayout";
import type { Room, TourNode, Vec2 } from "@/lib/schema";

/**
 * Front end for the depth worker: one job at a time, with progress.
 *
 * Serialised deliberately. Running several inferences at once on WASM just
 * thrashes the same cores and makes the whole batch slower, while making the
 * progress number meaningless.
 */

export type DepthProgress = {
  stage: "idle" | "loading-model" | "working" | "done" | "error";
  backend?: "webgpu" | "wasm";
  completed: number;
  total: number;
  modelPercent?: number;
  message?: string;
};

/**
 * Distance from a camera to the furthest point of the room it stands in.
 *
 * This is the far anchor that turns the model's relative output into metres.
 * Corners are measured at ceiling height because the far top corner really is
 * the most distant thing in shot.
 */
export function farAnchorFor(
  room: Room,
  position: Vec2,
  eyeHeight: number,
  headingDeg?: number,
): number {
  const { x0, y0, x1, y1 } = boundsOf(room.polygon);
  const corners: Vec2[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const rise = Math.max(room.ceilingHeight - eyeHeight, eyeHeight);

  // With a heading, only what is in front of the camera can be in the photo.
  // Without one, the furthest corner is the best available bound - but it
  // overestimates for any shot not taken down the diagonal, which pushes the
  // far plane out and leaves the shell floating behind the dollhouse walls.
  if (headingDeg !== undefined) {
    const heading = (headingDeg * Math.PI) / 180;
    const forward: Vec2 = [Math.sin(heading), Math.cos(heading)];
    let furthest = 0;
    for (const c of corners) {
      const dx = c[0] - position[0];
      const dy = c[1] - position[1];
      if (dx * forward[0] + dy * forward[1] <= 0) continue;
      furthest = Math.max(furthest, Math.hypot(dx, dy, rise));
    }
    if (furthest > 0.5) return furthest;
  }

  return Math.max(
    ...corners.map((c) => Math.hypot(c[0] - position[0], c[1] - position[1], rise)),
  );
}

/** Nearest plausible surface. Furniture edges land around here in practice. */
const NEAR_ANCHOR_M = 0.6;

export type DepthJob = {
  node: TourNode;
  room: Room;
  blob: Blob;
};

export class DepthEstimator {
  private worker: Worker | null = null;
  private pending = new Map<string, { resolve: (b: Blob) => void; reject: (e: Error) => void }>();
  private backend?: "webgpu" | "wasm";

  private ensureWorker(onProgress?: (p: Partial<DepthProgress>) => void): Worker {
    if (this.worker) return this.worker;

    this.worker = new Worker(new URL("./depth.worker.ts", import.meta.url), {
      type: "module",
    });

    this.worker.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (data.type === "backend") {
        this.backend = data.backend;
        onProgress?.({ backend: data.backend });
        return;
      }
      if (data.type === "progress") {
        const payload = data.payload;
        if (payload?.status === "progress" && typeof payload.progress === "number") {
          onProgress?.({ stage: "loading-model", modelPercent: Math.round(payload.progress) });
        }
        return;
      }
      const waiter = this.pending.get(data.id);
      if (!waiter) return;
      this.pending.delete(data.id);
      if (data.type === "done") waiter.resolve(data.blob as Blob);
      else waiter.reject(new Error(data.message ?? "depth estimation failed"));
    };

    this.worker.onerror = (event) => {
      for (const [, waiter] of this.pending) {
        waiter.reject(new Error(event.message || "depth worker crashed"));
      }
      this.pending.clear();
    };

    return this.worker;
  }

  private estimateOne(job: DepthJob, onProgress?: (p: Partial<DepthProgress>) => void): Promise<Blob> {
    const worker = this.ensureWorker(onProgress);
    return new Promise((resolve, reject) => {
      this.pending.set(job.node.id, { resolve, reject });
      worker.postMessage({
        type: "estimate",
        id: job.node.id,
        blob: job.blob,
        nearM: NEAR_ANCHOR_M,
        farM: farAnchorFor(job.room, job.node.position, job.node.eyeHeight, job.node.heading),
      });
    });
  }

  /**
   * Run a batch, reporting after each photo and surviving individual failures.
   * One bad image must not cost the user the other twenty-four - a node with no
   * depth simply falls back to a flat photo.
   */
  async run(
    jobs: DepthJob[],
    onProgress: (progress: DepthProgress) => void,
    onEach: (nodeId: string, depth: Blob) => Promise<void> | void,
  ): Promise<void> {
    let completed = 0;
    onProgress({ stage: "loading-model", completed, total: jobs.length });

    for (const job of jobs) {
      try {
        const blob = await this.estimateOne(job, (partial) =>
          onProgress({
            stage: "loading-model",
            completed,
            total: jobs.length,
            backend: this.backend,
            ...partial,
          }),
        );
        await onEach(job.node.id, blob);
      } catch (error) {
        onProgress({
          stage: "working",
          completed,
          total: jobs.length,
          backend: this.backend,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      completed += 1;
      onProgress({
        stage: completed === jobs.length ? "done" : "working",
        completed,
        total: jobs.length,
        backend: this.backend,
      });
    }
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
