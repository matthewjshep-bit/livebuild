"use client";

import { useEffect, useState } from "react";

import type { Selection } from "@/components/editor/PlanEditor";
import { area } from "@/lib/plan/geometry";
import { mediaRef, putMedia, resolveMediaUrl } from "@/lib/media-store";
import type { Property, TourNode, Vec2 } from "@/lib/schema";
import { M_PER_FT, formatArea, mToFt } from "@/lib/units";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-mist-400">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded border border-ink-600 bg-ink-700 px-2 py-1 text-sm outline-none focus:border-accent-dim";

/** Thumbnail for a photo that may live in IndexedDB rather than at a URL. */
function MediaThumb({ src }: { src: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!src) {
      setUrl(null);
      return;
    }
    resolveMediaUrl(src).then((resolved) => {
      if (!cancelled) setUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (!url) {
    return (
      <div className="grid h-24 place-items-center rounded border border-dashed border-ink-600 text-xs text-mist-400">
        No photo
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className="h-24 w-full rounded object-cover" />;
}

export function Inspector({
  property,
  selection,
  orphans,
  onUpdate,
  onSelect,
  children,
}: {
  property: Property;
  selection: Selection;
  orphans: TourNode[];
  onUpdate: (next: Property) => void;
  onSelect: (selection: Selection) => void;
  /** Pinned to the bottom of the panel, below whatever is selected. Work on the
   *  whole house rather than on one thing in it. */
  children?: React.ReactNode;
}) {
  const room =
    selection?.kind === "room"
      ? property.plan.rooms.find((r) => r.id === selection.id) ?? null
      : null;
  const node =
    selection?.kind === "node"
      ? property.nodes.find((n) => n.id === selection.id) ?? null
      : null;
  const opening =
    selection?.kind === "opening"
      ? property.plan.openings.find((o) => o.id === selection.id) ?? null
      : null;

  const patchNode = (id: string, patch: Partial<TourNode>) =>
    onUpdate({
      ...property,
      nodes: property.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    });

  const uploadFor = async (node: TourNode, kind: "photo" | "depth", file: File) => {
    const key = `${property.id}/${node.id}/${kind}`;
    await putMedia(key, file);
    // Bust the ref so a replaced file is not served from the URL cache.
    patchNode(node.id, { [kind]: `${mediaRef(key)}?v=${Date.now()}` } as Partial<TourNode>);
  };

  /**
   * Rescale the whole plan so the selected room matches a known real dimension.
   *
   * Drawing on a foot grid is usually close enough, but the plan is drawn from
   * memory and memory is proportionally wrong more often than it is locally
   * wrong. One real measurement fixes the whole document at once, which is
   * cheaper than correcting every room by hand.
   */
  const calibrate = (trueWidthFt: number) => {
    if (!room || trueWidthFt <= 0) return;
    const xs = room.polygon.map((p) => p[0]);
    const currentWidth = Math.max(...xs) - Math.min(...xs);
    if (currentWidth < 1e-6) return;
    const factor = (trueWidthFt * M_PER_FT) / currentWidth;

    onUpdate({
      ...property,
      plan: {
        ...property.plan,
        scaleRef: { px: 1, meters: property.plan.scaleRef.meters * factor },
        rooms: property.plan.rooms.map((r) => ({
          ...r,
          polygon: r.polygon.map(([x, y]) => [x * factor, y * factor] as Vec2),
        })),
        openings: property.plan.openings.map((o) => ({
          ...o,
          at: [o.at[0] * factor, o.at[1] * factor] as Vec2,
          width: o.width * factor,
        })),
      },
      nodes: property.nodes.map((n) => ({
        ...n,
        position: [n.position[0] * factor, n.position[1] * factor] as Vec2,
      })),
    });
  };

  return (
    <aside className="w-72 shrink-0 space-y-4 overflow-y-auto border-l border-ink-600 bg-ink-800 p-4">
      {!selection && (
        <div className="space-y-3 text-xs text-mist-400">
          <p>Nothing selected.</p>
          <ul className="space-y-1.5 leading-relaxed">
            <li>
              <strong className="text-mist-200">Room</strong> - drag out each room roughly to
              scale.
            </li>
            <li>
              <strong className="text-mist-200">Door</strong> - click a shared wall. Doorways
              are what let a viewer step between rooms.
            </li>
            <li>
              <strong className="text-mist-200">Camera</strong> - click where a photo was taken,
              then drag its handle to aim it.
            </li>
          </ul>
          <div className="border-t border-ink-600 pt-3">
            {property.plan.rooms.length} rooms &middot; {property.nodes.length} viewpoints
            {orphans.length > 0 && (
              <p className="mt-2 text-warn">
                {orphans.length} unreachable. Check for a missing doorway.
              </p>
            )}
          </div>
        </div>
      )}

      {room && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Room</h2>
          <Field label="Label">
            <input
              className={inputClass}
              value={room.label}
              onChange={(e) =>
                onUpdate({
                  ...property,
                  plan: {
                    ...property.plan,
                    rooms: property.plan.rooms.map((r) =>
                      r.id === room.id ? { ...r, label: e.target.value } : r,
                    ),
                  },
                })
              }
            />
          </Field>

          <Field label="Ceiling height (ft)">
            <input
              className={inputClass}
              type="number"
              step="0.5"
              value={+mToFt(room.ceilingHeight).toFixed(1)}
              onChange={(e) =>
                onUpdate({
                  ...property,
                  plan: {
                    ...property.plan,
                    rooms: property.plan.rooms.map((r) =>
                      r.id === room.id
                        ? { ...r, ceilingHeight: Number(e.target.value) * M_PER_FT }
                        : r,
                    ),
                  },
                })
              }
            />
          </Field>

          <div className="text-xs text-mist-400">
            {formatArea(area(room.polygon), property.displayUnits)}
          </div>

          <Field label="Calibrate: this room's true width (ft)">
            <input
              className={inputClass}
              type="number"
              step="0.5"
              placeholder="e.g. 12"
              onKeyDown={(e) => {
                if (e.key === "Enter") calibrate(Number(e.currentTarget.value));
              }}
            />
          </Field>
          <p className="text-[11px] leading-relaxed text-mist-400">
            Press Enter to rescale the entire plan so this room matches. One real measurement
            fixes the whole drawing.
          </p>

          <button
            onClick={() => {
              onUpdate({
                ...property,
                plan: {
                  ...property.plan,
                  rooms: property.plan.rooms.filter((r) => r.id !== room.id),
                  openings: property.plan.openings.filter(
                    (o) => !o.between.includes(room.id),
                  ),
                },
                nodes: property.nodes.filter((n) => n.roomId !== room.id),
              });
              onSelect(null);
            }}
            className="w-full rounded border border-ink-500 px-3 py-1.5 text-xs text-warn hover:bg-ink-600"
          >
            Delete room and its viewpoints
          </button>
        </div>
      )}

      {opening && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Doorway</h2>
          <p className="text-xs text-mist-400">
            {opening.between.join("  <->  ")}
          </p>
          <Field label="Width (ft)">
            <input
              className={inputClass}
              type="number"
              step="0.5"
              value={+mToFt(opening.width).toFixed(1)}
              onChange={(e) =>
                onUpdate({
                  ...property,
                  plan: {
                    ...property.plan,
                    openings: property.plan.openings.map((o) =>
                      o.id === opening.id
                        ? { ...o, width: Number(e.target.value) * M_PER_FT }
                        : o,
                    ),
                  },
                })
              }
            />
          </Field>
          <button
            onClick={() => {
              onUpdate({
                ...property,
                plan: {
                  ...property.plan,
                  openings: property.plan.openings.filter((o) => o.id !== opening.id),
                },
              });
              onSelect(null);
            }}
            className="w-full rounded border border-ink-500 px-3 py-1.5 text-xs text-warn hover:bg-ink-600"
          >
            Delete doorway
          </button>
        </div>
      )}

      {node && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Viewpoint</h2>
          <MediaThumb src={node.photo} />

          <Field label="Photo">
            <input
              type="file"
              accept="image/*"
              className="w-full text-xs text-mist-400 file:mr-2 file:rounded file:border-0 file:bg-ink-600 file:px-2 file:py-1 file:text-xs file:text-mist-200"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadFor(node, "photo", file);
              }}
            />
          </Field>

          <Field label="Depth map (from the pipeline)">
            <input
              type="file"
              accept="image/png"
              className="w-full text-xs text-mist-400 file:mr-2 file:rounded file:border-0 file:bg-ink-600 file:px-2 file:py-1 file:text-xs file:text-mist-200"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadFor(node, "depth", file);
              }}
            />
          </Field>
          <p className="text-[11px] leading-relaxed text-mist-400">
            {node.depth
              ? "Depth present - renders as a 2.5D shell with parallax."
              : "No depth - renders as a flat photo. Run pipeline/spike.py to generate one."}
          </p>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Heading">
              <input
                className={inputClass}
                type="number"
                value={Math.round(node.heading)}
                onChange={(e) => patchNode(node.id, { heading: Number(e.target.value) })}
              />
            </Field>
            <Field label="Lens FOV">
              <input
                className={inputClass}
                type="number"
                value={node.fovDeg}
                onChange={(e) => patchNode(node.id, { fovDeg: Number(e.target.value) })}
              />
            </Field>
            <Field label="Eye height (ft)">
              <input
                className={inputClass}
                type="number"
                step="0.5"
                value={+mToFt(node.eyeHeight).toFixed(1)}
                onChange={(e) =>
                  patchNode(node.id, { eyeHeight: Number(e.target.value) * M_PER_FT })
                }
              />
            </Field>
            <Field label="Parallax (m)">
              <input
                className={inputClass}
                type="number"
                step="0.05"
                value={node.parallaxBudget}
                onChange={(e) =>
                  patchNode(node.id, { parallaxBudget: Number(e.target.value) })
                }
              />
            </Field>
          </div>

          <div className="text-[11px] text-mist-400">
            Connects to: {node.neighbors.length ? node.neighbors.join(", ") : "nothing yet"}
          </div>

          <a
            href={`/tour/${property.id}?node=${node.id}`}
            className="block rounded border border-ink-500 px-3 py-1.5 text-center text-xs hover:bg-ink-600"
          >
            Preview this viewpoint
          </a>

          <button
            onClick={() => {
              onUpdate({
                ...property,
                nodes: property.nodes.filter((n) => n.id !== node.id),
              });
              onSelect(null);
            }}
            className="w-full rounded border border-ink-500 px-3 py-1.5 text-xs text-warn hover:bg-ink-600"
          >
            Delete viewpoint
          </button>
        </div>
      )}

      {children && <div className="border-t border-ink-600 pt-4">{children}</div>}
    </aside>
  );
}
