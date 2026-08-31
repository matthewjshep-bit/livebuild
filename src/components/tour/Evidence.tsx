"use client";

import { useEffect, useMemo, useState } from "react";

import type { Property } from "@/lib/schema";

/**
 * The photographs, beside the model rather than on it.
 *
 * They used to be the tour: posed in the plan, projected onto a depth shell,
 * and the thing you actually looked at. They are evidence now. The replica is
 * built from what they show, and the question they are still the only answer to
 * - "is that really what the kitchen looks like?" - is one you ask while
 * looking at the room, not instead of looking at it.
 *
 * The property reaching this component is hydrated, so `node.photo` is already
 * an object URL or a plain path. Nothing here has to know about IndexedDB.
 */

export function Evidence({
  property,
  roomId,
}: {
  property: Property;
  /** The room being looked at, or null for the whole house. */
  roomId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [zoomed, setZoomed] = useState<string | null>(null);

  const photos = useMemo(
    () => (roomId ? property.nodes.filter((n) => n.roomId === roomId) : property.nodes),
    [property.nodes, roomId],
  );

  const room = roomId ? property.plan.rooms.find((r) => r.id === roomId) ?? null : null;

  // Escape closes the zoom first and the panel second, so it never takes two
  // presses to get back to the house from a photograph.
  useEffect(() => {
    if (!open && !zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (zoomed) setZoomed(null);
      else setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, zoomed]);

  if (property.nodes.length === 0) return null;

  return (
    <>
      <div data-evidence>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="w-full rounded-lg border border-ink-600 bg-ink-800/90 px-3 py-2 text-left text-[11px] text-mist-200 backdrop-blur transition hover:border-ink-500"
        >
          <span className="uppercase tracking-wide text-mist-400">Built from</span>{" "}
          <span className="tabular-nums">{photos.length}</span>{" "}
          {photos.length === 1 ? "photo" : "photos"}
          {room && <span className="text-mist-400"> · {room.label}</span>}
          <span className="float-right text-mist-400">{open ? "▾" : "▸"}</span>
        </button>

        {open && (
          <div className="mt-1.5 max-h-[60vh] overflow-y-auto rounded-lg border border-ink-600 bg-ink-800/90 p-2 backdrop-blur">
            {photos.length === 0 ? (
              <p className="px-1 py-2 text-[11px] leading-relaxed text-mist-400">
                No photograph shows this room. What you are looking at was inferred from the plan
                and the rooms around it.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {photos.map((node) => (
                  <button
                    key={node.id}
                    onClick={() => setZoomed(node.photo)}
                    className="overflow-hidden rounded border border-ink-600 transition hover:border-accent-dim"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={node.photo}
                      alt={`Source photograph of ${room?.label ?? "the house"}`}
                      loading="lazy"
                      className="aspect-[4/3] w-full object-cover"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {zoomed && (
        <div
          className="absolute inset-0 z-10 grid place-items-center bg-ink-900/85 p-8 backdrop-blur"
          onClick={() => setZoomed(null)}
          role="presentation"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={zoomed}
            alt="Source photograph"
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
          />
          <p className="absolute bottom-6 text-[11px] text-mist-400">
            A photograph the model was built from · click anywhere to close
          </p>
        </div>
      )}
    </>
  );
}
