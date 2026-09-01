"use client";

import { useEffect, useRef, useState } from "react";

import { SketchPad } from "@/components/wizard/SketchPad";

import { type SketchReading, sketchToPlan } from "@/lib/plan/sketch";
import type { Plan } from "@/lib/schema";
import { M_PER_FT } from "@/lib/units";

/**
 * Build the layout from a drawing instead of by dragging.
 *
 * Dragging rectangles is the worst part of the builder, and no amount of
 * snapping fixes the underlying problem: the arrangement already exists in the
 * user's head and a mouse is a slow way to get it out. A sketch on a notepad
 * carries it in one gesture.
 */

const MAX_EDGE = 1600;

/** Phone photos of paper are large and mostly redundant detail. */
async function prepare(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.86);
}

export function SketchImport({
  livingAreaSqft,
  onPlan,
}: {
  livingAreaSqft?: number;
  onPlan: (plan: Plan, notes: string[]) => void;
}) {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Drawing is the default. Photographing paper works, but it assumes you are
  // not already sitting at the machine you are building the tour on.
  /**
   * "photo" and "floorplan" take the same picture down the same path and differ
   * only in what the reader is told it is looking at - which is worth a mode of
   * its own, because a printed plan carries written dimensions and a great deal
   * of furniture drawn to a standard that makes it look structural.
   */
  const [mode, setMode] = useState<"draw" | "photo" | "floorplan">("draw");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/sketch")
      .then((r) => r.json())
      .then((d) => setAvailable(Boolean(d.available)))
      .catch(() => setAvailable(false));
  }, []);

  if (!available) return null;

  /** Shared by both routes in: a drawing is a drawing, however it arrived. */
  const interpret = async (dataUrl: string) => {
    setBusy(true);
    setError(null);
    try {

      const response = await fetch("/api/sketch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: dataUrl, kind: mode === "floorplan" ? "floorplan" : "sketch" }),
      });

      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        setError(
          detail.error === "no-rooms"
            ? "No rooms found in that image. A plain outline of each room, labelled, reads best."
            : "Could not read that drawing.",
        );
        return;
      }

      const reading: SketchReading = await response.json();
      const { rooms, openings, adjustments } = sketchToPlan(reading, livingAreaSqft);

      // Both halves are worth showing: what it saw, and what it then changed.
      // A plan that silently differs from the drawing reads as a misreading.
      onPlan(
        { scaleRef: { px: 1, meters: M_PER_FT }, rooms, openings },
        [...(reading.notes ?? []), ...adjustments],
      );
      setOpen(false);
    } catch {
      setError("Something went wrong reading that drawing.");
    } finally {
      setBusy(false);
    }
  };

  const readFile = async (file: File) => {
    const dataUrl = await prepare(file);
    setPreview(dataUrl);
    await interpret(dataUrl);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded border border-accent-dim bg-accent/10 px-2.5 py-1.5 text-xs text-mist-200 hover:bg-accent/20"
      >
        Draw the layout
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-ink-600 bg-ink-800 p-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-medium">Draw the layout</h3>
          <p className="mt-1 text-xs leading-relaxed text-mist-400">
            A box per room with its name in it is all it needs. Write a size like{" "}
            <span className="text-mist-200">12x14</span> inside a room and everything else is
            scaled from it.
          </p>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="text-xs text-mist-400 hover:text-mist-200"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="mt-3 flex gap-1.5">
        <button
          onClick={() => setMode("draw")}
          className={`rounded px-3 py-1.5 text-xs transition ${
            mode === "draw"
              ? "bg-accent text-ink-900"
              : "border border-ink-500 text-mist-200 hover:bg-ink-600"
          }`}
        >
          Draw it here
        </button>
        <button
          onClick={() => setMode("photo")}
          className={`rounded px-3 py-1.5 text-xs transition ${
            mode === "photo"
              ? "bg-accent text-ink-900"
              : "border border-ink-500 text-mist-200 hover:bg-ink-600"
          }`}
        >
          Photo of paper
        </button>
        <button
          onClick={() => setMode("floorplan")}
          data-testid="import-floorplan"
          className={`rounded px-3 py-1.5 text-xs transition ${
            mode === "floorplan"
              ? "bg-accent text-ink-900"
              : "border border-ink-500 text-mist-200 hover:bg-ink-600"
          }`}
        >
          Floor plan
        </button>
      </div>

      {mode === "draw" && (
        <div className="mt-3">
          <SketchPad busy={busy} onRead={(dataUrl) => void interpret(dataUrl)} />
          {error && <p className="mt-2 text-xs text-warn">{error}</p>}
        </div>
      )}

      {(mode === "photo" || mode === "floorplan") && (
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void readFile(file);
        }}
        onClick={() => !busy && inputRef.current?.click()}
        className={`mt-3 grid cursor-pointer place-items-center rounded-lg border-2 border-dashed px-4 py-8 text-center transition ${
          dragging ? "border-accent bg-accent/10" : "border-ink-500 hover:border-accent-dim"
        } ${busy ? "opacity-60" : ""}`}
      >
        {preview && busy ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" className="max-h-40 rounded opacity-70" />
        ) : (
          <div className="space-y-1">
            <div className="text-3xl">{busy ? "👀" : "✏️"}</div>
            <p className="text-sm text-mist-200">
              {busy
                ? "Reading your drawing…"
                : mode === "floorplan"
                  ? "Drop the floor plan"
                  : "Drop a photo of your sketch"}
            </p>
            {!busy && (
              <p className="text-xs text-mist-400">
                {mode === "floorplan"
                  ? "From a listing, an appraisal or a builder — written dimensions are used"
                  : "or click to choose one"}
              </p>
            )}
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void readFile(file);
            e.target.value = "";
          }}
        />
      </div>
      )}

      {mode !== "draw" && error && <p className="mt-2 text-xs text-warn">{error}</p>}
      <p className="mt-2 text-[11px] text-mist-400">
        This replaces the current layout. You can still drag and rotate afterwards.
      </p>
    </div>
  );
}
