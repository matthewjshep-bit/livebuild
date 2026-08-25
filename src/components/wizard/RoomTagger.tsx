"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { ImportedPhoto } from "@/components/wizard/PhotoDrop";
import { type HouseSpec, roomOptionsFor } from "@/lib/plan/describe";

/**
 * Step two: which room is this?
 *
 * The only question the user is ever asked about a photo. It is deliberately
 * one tap, auto-advancing, with the rooms already used floated to the front -
 * a house has three bedrooms far more often than it has three different room
 * types, so the second bedroom photo should be one tap, not a hunt.
 *
 * Number keys work too, because tagging thirty photos with a mouse is a chore
 * and tagging them with the left hand is not.
 */
export function RoomTagger({
  photos,
  spec,
  tagging,
  uncertain,
  onAutoTag,
  onTag,
}: {
  photos: ImportedPhoto[];
  /** From the description step, if it was used. */
  spec: HouseSpec | null;
  /** Progress while the vision pass runs, or null when idle. */
  tagging: { done: number; total: number } | null;
  /** How many guesses the model flagged as uncertain. */
  uncertain: number;
  onAutoTag: () => Promise<void>;
  onTag: (photoId: string, label: string | null) => void;
}) {
  const [index, setIndex] = useState(0);
  const [custom, setCustom] = useState("");
  const [canAutoTag, setCanAutoTag] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/classify")
      .then((r) => r.json())
      .then((d) => setCanAutoTag(Boolean(d.available)))
      .catch(() => setCanAutoTag(false));
  }, []);

  const current = photos[index];
  const remaining = photos.filter((p) => !p.roomLabel).length;
  const untagged = remaining;

  /**
   * Rooms already used come first, then the ones the description implies, then
   * the generic presets.
   *
   * The middle group is the point of describing the house at all: after "3 bed
   * 2 bath" the buttons read Primary Bedroom / Bedroom 2 / Bedroom 3, so three
   * bedroom photos can actually be told apart. A single generic "Bedroom" would
   * collapse them into one room.
   */
  const options = useMemo(() => {
    const used: string[] = [];
    for (const photo of photos) {
      if (photo.roomLabel && !used.includes(photo.roomLabel)) used.push(photo.roomLabel);
    }
    const described = roomOptionsFor(spec);
    return [...used, ...described.filter((r) => !used.includes(r))];
  }, [photos, spec]);

  const assign = (label: string | null) => {
    if (!current) return;
    onTag(current.id, label);
    // Jump to the next untagged photo rather than simply the next one, so
    // going back to fix one does not then walk you through everything after it.
    const nextUntagged = photos.findIndex((p, i) => i > index && !p.roomLabel);
    setIndex(nextUntagged === -1 ? Math.min(index + 1, photos.length - 1) : nextUntagged);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowRight") setIndex((i) => Math.min(i + 1, photos.length - 1));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
      const digit = Number(e.key);
      if (digit >= 1 && digit <= 9 && options[digit - 1]) assign(options[digit - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!current) return null;

  return (
    <div ref={containerRef} className="mx-auto w-full max-w-5xl">
      <div className="grid gap-6 md:grid-cols-[1.4fr_1fr]">
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={current.url}
            alt={current.name}
            className="w-full rounded-lg border border-ink-600 object-contain"
            style={{ maxHeight: "58vh" }}
          />
          <div className="mt-3 flex items-center justify-between text-xs text-mist-400">
            <button
              onClick={() => setIndex(Math.max(index - 1, 0))}
              disabled={index === 0}
              className="rounded border border-ink-500 px-3 py-1 disabled:opacity-30"
            >
              ← Back
            </button>
            <span>
              Photo {index + 1} of {photos.length}
              {remaining > 0 && ` · ${remaining} still to label`}
            </span>
            <button
              onClick={() => setIndex(Math.min(index + 1, photos.length - 1))}
              disabled={index === photos.length - 1}
              className="rounded border border-ink-500 px-3 py-1 disabled:opacity-30"
            >
              Skip →
            </button>
          </div>
        </div>

        <div>
          <h2 className="text-lg font-medium">What room is this?</h2>
          <p className="mt-1 text-sm text-mist-400">
            Tap one. Photos of the same room are grouped together.
          </p>

          {canAutoTag && untagged > 0 && (
            <button
              onClick={() => void onAutoTag()}
              disabled={tagging !== null}
              className="mt-3 w-full rounded border border-accent-dim bg-accent/10 px-3 py-2 text-xs text-mist-200 transition hover:bg-accent/20 disabled:opacity-50"
            >
              {tagging
                ? `Looking at your photos… ${tagging.done}/${tagging.total}`
                : `Label all ${untagged} for me`}
            </button>
          )}

          {uncertain > 0 && untagged === 0 && (
            <button
              onClick={() => {
                const next = photos.findIndex((p) => p.guessed === "low");
                if (next >= 0) setIndex(next);
              }}
              className="mt-3 w-full rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
            >
              {uncertain} guess{uncertain === 1 ? "" : "es"} the model was unsure about &mdash;
              review {uncertain === 1 ? "it" : "them"}
            </button>
          )}

          {current.guessed && (
            <p
              className={`mt-2 text-[11px] ${
                current.guessed === "low" ? "text-warn" : "text-mist-400"
              }`}
            >
              {current.guessed === "low"
                ? "Guessed, but this photo was ambiguous — worth a look."
                : "Guessed from the photo. Tap to change."}
            </p>
          )}

          <div className="mt-4 grid grid-cols-2 gap-2">
            {options.slice(0, 14).map((label, i) => (
              <button
                key={label}
                onClick={() => assign(label)}
                // The visible shortcut digit would otherwise be read out as part
                // of the room name ("6Bathroom") by screen readers.
                aria-label={label}
                className={`rounded-lg border px-3 py-2.5 text-left text-sm transition ${
                  current.roomLabel === label
                    ? "border-accent bg-accent text-ink-900"
                    : "border-ink-500 bg-ink-800 hover:border-accent-dim hover:bg-ink-700"
                }`}
              >
                <span className="mr-1.5 text-xs opacity-50">{i < 9 ? i + 1 : " "}</span>
                {label}
              </button>
            ))}
          </div>

          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (custom.trim()) {
                assign(custom.trim());
                setCustom("");
              }
            }}
          >
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Or type another room name"
              className="flex-1 rounded border border-ink-600 bg-ink-700 px-2 py-1.5 text-sm outline-none focus:border-accent-dim"
            />
            <button className="rounded border border-ink-500 px-3 text-sm hover:bg-ink-600">
              Add
            </button>
          </form>

          {current.roomLabel && (
            <button
              onClick={() => assign(null)}
              className="mt-3 text-xs text-mist-400 underline underline-offset-4"
            >
              Clear this photo&rsquo;s room
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
