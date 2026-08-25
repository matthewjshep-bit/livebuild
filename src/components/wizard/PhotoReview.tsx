"use client";

import { useMemo, useState } from "react";

import type { ImportedPhoto } from "@/components/wizard/PhotoDrop";
import { roomOptionsFor } from "@/lib/plan/describe";
import type { HouseSpec } from "@/lib/plan/describe";

/**
 * Check the room labels, rather than author them.
 *
 * Every photo already has a label by the time this is shown. Reviewing a strip
 * of thumbnails is a glance; producing thirty labels one tap at a time was the
 * longest part of the old flow. Anything the model was unsure of is pulled to
 * the front, because those are the only ones actually worth a look.
 */
export function PhotoReview({
  photos,
  spec,
  onTag,
}: {
  photos: ImportedPhoto[];
  spec: HouseSpec | null;
  onTag: (photoId: string, label: string | null) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  const options = useMemo(() => {
    const used: string[] = [];
    for (const photo of photos) {
      if (photo.roomLabel && !used.includes(photo.roomLabel)) used.push(photo.roomLabel);
    }
    const described = roomOptionsFor(spec);
    return [...used, ...described.filter((r) => !used.includes(r))];
  }, [photos, spec]);

  const needsLook = photos.filter((p) => !p.roomLabel || p.guessed === "low");
  const shown = showAll ? photos : needsLook.length > 0 ? needsLook : photos.slice(0, 6);

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-medium">
          {needsLook.length > 0
            ? `${needsLook.length} photo${needsLook.length === 1 ? "" : "s"} worth a glance`
            : "Every photo placed"}
        </h3>
        <button
          onClick={() => setShowAll((v) => !v)}
          className="text-xs text-mist-400 underline underline-offset-4 hover:text-mist-200"
        >
          {showAll ? "Just the uncertain ones" : `Show all ${photos.length}`}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {shown.map((photo) => (
          <div key={photo.id} className="overflow-hidden rounded-lg border border-ink-600">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photo.url} alt={photo.name} className="aspect-4/3 w-full object-cover" />
            <div className="p-1.5">
              <select
                value={photo.roomLabel ?? ""}
                onChange={(e) => onTag(photo.id, e.target.value || null)}
                className={`w-full rounded border bg-ink-700 px-1.5 py-1 text-xs outline-none ${
                  photo.guessed === "low" || !photo.roomLabel
                    ? "border-warn/50 text-warn"
                    : "border-ink-600 text-mist-200"
                }`}
              >
                <option value="">Not in the tour</option>
                {options.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
