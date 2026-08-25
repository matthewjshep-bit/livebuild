"use client";

import { useCallback, useEffect, useState } from "react";

import { DepthEstimator, type DepthProgress } from "@/lib/depth/client";
import { getMedia, mediaRef, putMedia, refToKey } from "@/lib/media-store";
import { loadProperty, saveProperty } from "@/lib/property-store";
import type { Property } from "@/lib/schema";

/**
 * Finish depth for any viewpoints that never got it.
 *
 * Inference runs on the page that started it, so leaving the wizard early - or
 * closing the tab - stops it for good. The nodes keep `depth: null` and quietly
 * render as flat photos forever, with nothing anywhere offering to try again.
 *
 * This is that offer, placed where the problem is actually noticed rather than
 * where it was caused.
 */
export function FinishProcessing({
  property,
  onUpdated,
}: {
  property: Property;
  onUpdated: (property: Property) => void;
}) {
  const [progress, setProgress] = useState<DepthProgress | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [missing, setMissing] = useState(0);

  /**
   * Count from the *stored* document, not the one on screen.
   *
   * The viewer is handed a hydrated copy whose `photo` fields have been swapped
   * for object URLs, so testing them for an `idb:` prefix silently matches
   * nothing - which is exactly how this banner failed to appear on a tour that
   * genuinely had no depth at all.
   */
  const recount = useCallback(() => {
    const stored = loadProperty(property.id);
    if (!stored) {
      setMissing(0);
      return;
    }
    // Bundled samples ship static depth files that are not ours to rewrite.
    setMissing(
      stored.nodes.filter((n) => !n.depth && n.photo.startsWith("idb:")).length,
    );
  }, [property.id]);

  useEffect(recount, [recount, property.nodes]);

  if (missing === 0 || dismissed) return null;

  const run = async () => {
    // Re-read rather than trusting the copy in memory, which may be hydrated
    // with object URLs and would write those back into the saved document.
    const stored = loadProperty(property.id);
    if (!stored) return;

    const jobs = (
      await Promise.all(
        stored.nodes
          .filter((n) => !n.depth && n.photo.startsWith("idb:"))
          .map(async (node) => {
            const room = stored.plan.rooms.find((r) => r.id === node.roomId);
            const blob = room ? await getMedia(refToKey(node.photo)) : null;
            return room && blob ? { node, room, blob } : null;
          }),
      )
    ).filter(Boolean) as Array<{
      node: Property["nodes"][number];
      room: Property["plan"]["rooms"][number];
      blob: Blob;
    }>;

    if (jobs.length === 0) {
      setMissing(0);
      return;
    }

    const estimator = new DepthEstimator();
    let working = stored;

    await estimator.run(jobs, setProgress, async (nodeId, blob) => {
      const key = `${property.id}/${nodeId}/depth`;
      await putMedia(key, blob);
      working = {
        ...working,
        nodes: working.nodes.map((n) =>
          n.id === nodeId ? { ...n, depth: mediaRef(key) } : n,
        ),
      };
      // Saved as each lands, so a second interruption still keeps the work.
      saveProperty(working);
    });

    estimator.dispose();
    recount();
    onUpdated(working);
  };

  const running = progress !== null && progress.stage !== "done";

  return (
    <div className="absolute top-3 left-1/2 w-[min(30rem,90vw)] -translate-x-1/2 rounded-lg border border-ink-600 bg-ink-800/95 px-4 py-3 backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {running
              ? "Adding 3D depth…"
              : `${missing} photo${missing === 1 ? "" : "s"} still flat`}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-mist-400">
            {running
              ? progress?.stage === "loading-model" && progress.modelPercent !== undefined
                ? `Downloading the 3D model… ${progress.modelPercent}%`
                : `${progress?.completed ?? 0} of ${progress?.total ?? 0} done — you can keep looking around`
              : "Processing stopped before these finished, so they show as flat photos."}
          </p>
        </div>

        {!running && (
          <div className="flex shrink-0 gap-1.5">
            <button
              onClick={() => void run()}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-ink-900"
            >
              Finish it
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="rounded border border-ink-500 px-2.5 py-1.5 text-xs"
            >
              Later
            </button>
          </div>
        )}
      </div>

      {running && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink-600">
          <div
            className="h-full bg-accent transition-all"
            style={{
              width: `${
                progress?.stage === "loading-model" && progress.modelPercent !== undefined
                  ? progress.modelPercent
                  : progress && progress.total > 0
                    ? (progress.completed / progress.total) * 100
                    : 0
              }%`,
            }}
          />
        </div>
      )}
    </div>
  );
}
