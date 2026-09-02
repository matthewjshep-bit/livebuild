"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { usePlanView } from "@/components/editor/usePlanView";
import { AddPhotos } from "@/components/editor/AddPhotos";
import { Inspector } from "@/components/editor/Inspector";
import { ReshapeFromSatellite } from "@/components/editor/ReshapeFromSatellite";
import {
  area,
  centroid,
  dist,
  pointInPolygon,
  projectOnSegment,
} from "@/lib/plan/geometry";
import { buildWalkGraph, findOrphans } from "@/lib/plan/walkgraph";
import { downloadProperty, saveProperty } from "@/lib/property-store";
import type { Property, Room, Vec2 } from "@/lib/schema";
import { M_PER_FT, formatArea, formatLength, onWallGrid } from "@/lib/units";

export type Tool = "select" | "room" | "door" | "camera";
export type Selection =
  | { kind: "room"; id: string }
  | { kind: "opening"; id: string }
  | { kind: "node"; id: string }
  | null;

/** The grid the user sees. Two feet, because six inches is a hairline at zoom. */
const GRID_M = M_PER_FT * 2;

/** What a wall lands on, which is not the same as what is drawn behind it. */
function snap(value: number, enabled: boolean): number {
  return enabled ? onWallGrid(value) : value;
}

function nextId(prefix: string, taken: Set<string>): string {
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!taken.has(id)) return id;
  }
}

function rectPolygon(a: Vec2, b: Vec2): Vec2[] {
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  // Counter-clockwise, matching the winding the schema documents.
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

function roomAt(property: Property, point: Vec2): Room | undefined {
  return property.plan.rooms.find((r) => pointInPolygon(point, r.polygon));
}

export function PlanEditor({
  initial,
  onChange,
}: {
  initial: Property;
  onChange?: (property: Property) => void;
}) {
  const [property, setProperty] = useState<Property>(initial);
  const [tool, setTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<Selection>(null);
  const [snapping, setSnapping] = useState(true);
  const [draft, setDraft] = useState<{ from: Vec2; to: Vec2 } | null>(null);
  const [saved, setSaved] = useState(false);

  const { svgRef, view, toPlan, zoomAt, panBy, fit } = usePlanView(property.plan);

  const drag = useRef<
    | { kind: "pan"; x: number; y: number }
    | { kind: "moveRoom"; id: string; last: Vec2 }
    | { kind: "moveNode"; id: string; last: Vec2 }
    | null
  >(null);

  const update = useCallback(
    (next: Property) => {
      setProperty(next);
      setSaved(false);
      onChange?.(next);
    },
    [onChange],
  );

  // Autosave is debounced rather than on every keystroke: the walk graph is
  // rebuilt on save, which is wasted work while a label is being typed.
  //
  // An untouched blank property is never written, or merely opening the editor
  // would leave an empty entry on the home page every time.
  const isBlank =
    property.plan.rooms.length === 0 && property.nodes.length === 0 && !property.label;

  useEffect(() => {
    if (isBlank) return;
    const timer = setTimeout(() => {
      saveProperty(property);
      setSaved(true);
    }, 700);
    return () => clearTimeout(timer);
  }, [property, isBlank]);

  // The stored document's neighbours go stale the moment a room or doorway
  // moves, so the editor works from a freshly derived graph. Save persists the
  // same derivation, which keeps the two from drifting.
  const graphed = useMemo(
    () => buildWalkGraph(property.plan, property.nodes),
    [property.plan, property.nodes],
  );
  const orphans = useMemo(() => findOrphans(graphed), [graphed]);

  const commitRoom = useCallback(
    (from: Vec2, to: Vec2) => {
      const polygon = rectPolygon(from, to);
      if (area(polygon) < 0.5) return; // an accidental click, not a room
      const taken = new Set(property.plan.rooms.map((r) => r.id));
      const id = nextId("room", taken);
      update({
        ...property,
        plan: {
          ...property.plan,
          rooms: [
            ...property.plan.rooms,
            {
              id,
              label: `Room ${property.plan.rooms.length + 1}`,
              polygon,
              ceilingHeight: 2.7,
              level: 0,
            },
          ],
        },
      });
      setSelection({ kind: "room", id });
      setTool("select");
    },
    [property, update],
  );

  /**
   * Place a doorway by clicking near a wall.
   *
   * The user points at a wall, not at a pair of rooms, so the pair has to be
   * inferred: find the two rooms with an edge closest to the click. Requiring
   * them to pick rooms from a list would be faster to code and much slower to
   * use.
   */
  const commitDoor = useCallback(
    (point: Vec2) => {
      const hits: Array<{ roomId: string; distance: number; at: Vec2 }> = [];
      for (const room of property.plan.rooms) {
        let best = { distance: Infinity, at: point };
        for (let i = 0; i < room.polygon.length; i++) {
          const a = room.polygon[i];
          const b = room.polygon[(i + 1) % room.polygon.length];
          const { t, distance } = projectOnSegment(point, a, b);
          if (distance < best.distance) {
            best = {
              distance,
              at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
            };
          }
        }
        if (best.distance < 0.8) hits.push({ roomId: room.id, ...best });
      }

      hits.sort((p, q) => p.distance - q.distance);
      if (hits.length < 2) return;

      const taken = new Set(property.plan.openings.map((o) => o.id));
      const id = nextId("door", taken);
      update({
        ...property,
        plan: {
          ...property.plan,
          openings: [
            ...property.plan.openings,
            {
              id,
              between: [hits[0].roomId, hits[1].roomId],
              at: hits[0].at,
              width: 0.9,
              kind: "door",
            },
          ],
        },
      });
      setSelection({ kind: "opening", id });
      setTool("select");
    },
    [property, update],
  );

  const commitNode = useCallback(
    (point: Vec2) => {
      const room = roomAt(property, point);
      if (!room) return;
      const taken = new Set(property.nodes.map((n) => n.id));
      const id = nextId("n", taken);
      update({
        ...property,
        nodes: [
          ...property.nodes,
          {
            id,
            roomId: room.id,
            position: point,
            // The lens fields are vestigial: the schema keeps them so every
            // saved and published document parses, and nothing reads them. A
            // photograph is a record of a room now, not a camera. `depth` and
            // `parallaxBudget` went further and are gone - they existed only
            // for the 2.5D shell.
            eyeHeight: 1.5,
            heading: 0,
            pitch: 0,
            fovDeg: 78,
            photo: "",
            neighbors: [],
          },
        ],
      });
      setSelection({ kind: "node", id });
      setTool("select");
    },
    [property, update],
  );

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const point = toPlan(e.clientX, e.clientY);
    const snapped: Vec2 = [snap(point[0], snapping), snap(point[1], snapping)];
    (e.target as Element).setPointerCapture?.(e.pointerId);

    if (e.button === 1 || e.shiftKey || tool === "select") {
      const node = property.nodes.find((n) => dist(n.position, point) < 0.45);
      if (node && tool === "select" && !e.shiftKey) {
        setSelection({ kind: "node", id: node.id });
        drag.current = { kind: "moveNode", id: node.id, last: point };
        return;
      }
      const room = tool === "select" && !e.shiftKey ? roomAt(property, point) : undefined;
      if (room) {
        setSelection({ kind: "room", id: room.id });
        drag.current = { kind: "moveRoom", id: room.id, last: point };
        return;
      }
      if (tool === "select" && !e.shiftKey) setSelection(null);
      drag.current = { kind: "pan", x: e.clientX, y: e.clientY };
      return;
    }

    if (tool === "room") setDraft({ from: snapped, to: snapped });
    if (tool === "door") commitDoor(point);
    if (tool === "camera") commitNode(snapped);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const point = toPlan(e.clientX, e.clientY);

    if (draft) {
      setDraft({ ...draft, to: [snap(point[0], snapping), snap(point[1], snapping)] });
      return;
    }

    const active = drag.current;
    if (!active) return;

    if (active.kind === "pan") {
      panBy(e.clientX - active.x, e.clientY - active.y);
      drag.current = { kind: "pan", x: e.clientX, y: e.clientY };
      return;
    }

    if (active.kind === "moveRoom") {
      const dx = point[0] - active.last[0];
      const dy = point[1] - active.last[1];
      update({
        ...property,
        plan: {
          ...property.plan,
          rooms: property.plan.rooms.map((r) =>
            r.id === active.id
              ? { ...r, polygon: r.polygon.map(([x, y]) => [x + dx, y + dy] as Vec2) }
              : r,
          ),
        },
      });
      drag.current = { ...active, last: point };
      return;
    }

    if (active.kind === "moveNode") {
      const moved: Vec2 = [snap(point[0], snapping), snap(point[1], snapping)];
      const room = roomAt(property, moved);
      update({
        ...property,
        nodes: property.nodes.map((n) =>
          n.id === active.id
            ? { ...n, position: moved, roomId: room?.id ?? n.roomId }
            : n,
        ),
      });
      drag.current = { ...active, last: point };
      return;
    }

  };

  const onPointerUp = () => {
    if (draft) {
      commitRoom(draft.from, draft.to);
      setDraft(null);
    }
    drag.current = null;
  };

  const selectedRoom =
    selection?.kind === "room"
      ? property.plan.rooms.find((r) => r.id === selection.id) ?? null
      : null;
  const selectedNode =
    selection?.kind === "node"
      ? property.nodes.find((n) => n.id === selection.id) ?? null
      : null;

  return (
    <div className="app-shell">
      <header className="flex items-center justify-between gap-4 border-b border-ink-600 bg-ink-800 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="shrink-0 whitespace-nowrap text-xs text-mist-400 underline underline-offset-4"
          >
            &larr; All properties
          </Link>
          <input
            value={property.label}
            onChange={(e) => update({ ...property, label: e.target.value })}
            placeholder="Property name"
            className="w-56 rounded border border-ink-600 bg-ink-700 px-2 py-1 text-sm outline-none focus:border-accent-dim"
          />
          <span className="text-xs text-mist-400">
            {isBlank ? "Draw a room to begin" : saved ? "Saved" : "Saving..."}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {(["select", "room", "door", "camera"] as Tool[]).map((t) => (
            <button
              key={t}
              onClick={() => setTool(t)}
              className={`rounded px-3 py-1 text-xs capitalize transition ${
                tool === t
                  ? "bg-accent text-ink-900"
                  : "border border-ink-500 text-mist-200 hover:bg-ink-600"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-mist-400">
            <input
              type="checkbox"
              checked={snapping}
              onChange={(e) => setSnapping(e.target.checked)}
            />
            Snap 6&quot;
          </label>
          <button
            onClick={fit}
            className="rounded border border-ink-500 px-3 py-1 text-xs hover:bg-ink-600"
          >
            Fit
          </button>
          <button
            onClick={() => downloadProperty(property)}
            className="rounded border border-ink-500 px-3 py-1 text-xs hover:bg-ink-600"
          >
            Export
          </button>
          <a
            href={`/tour/${property.id}`}
            className="rounded bg-accent px-3 py-1 text-xs font-medium text-ink-900"
          >
            Open tour
          </a>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <svg
          ref={svgRef}
          viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
          className="flex-1 touch-none bg-ink-900"
          style={{ cursor: tool === "select" ? "default" : "crosshair" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onWheel={(e) => zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.1 : 0.9)}
        >
          <Grid view={view} />

          {property.plan.rooms.map((room) => (
            <g key={room.id}>
              <polygon
                points={room.polygon.map((p) => p.join(",")).join(" ")}
                fill={selectedRoom?.id === room.id ? "#2a6f9e55" : "#262d3799"}
                stroke={selectedRoom?.id === room.id ? "#4bb3fd" : "#3a434f"}
                strokeWidth={view.width / 500}
              />
              <text
                x={centroid(room.polygon)[0]}
                y={centroid(room.polygon)[1]}
                textAnchor="middle"
                fill="#c9d1da"
                fontSize={view.width / 55}
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                {room.label}
              </text>
              <text
                x={centroid(room.polygon)[0]}
                y={centroid(room.polygon)[1] + view.width / 40}
                textAnchor="middle"
                fill="#8a95a3"
                fontSize={view.width / 75}
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                {formatArea(area(room.polygon), property.displayUnits)}
              </text>
            </g>
          ))}

          {property.plan.openings.map((opening) => (
            <circle
              key={opening.id}
              cx={opening.at[0]}
              cy={opening.at[1]}
              r={opening.width / 2}
              fill="none"
              stroke={
                selection?.kind === "opening" && selection.id === opening.id
                  ? "#4bb3fd"
                  : "#f2a541"
              }
              strokeWidth={view.width / 450}
              onPointerDown={(e) => {
                e.stopPropagation();
                setSelection({ kind: "opening", id: opening.id });
              }}
            />
          ))}

          {property.nodes.map((node) => {
            const isSelected = selectedNode?.id === node.id;
            const isOrphan = orphans.some((o) => o.id === node.id);
            return (
              <g key={node.id}>
                <circle
                  cx={node.position[0]}
                  cy={node.position[1]}
                  r={view.width / 95}
                  fill={isSelected ? "#4bb3fd" : isOrphan ? "#f2a541" : "#c9d1da"}
                  stroke="#0b0d10"
                  strokeWidth={view.width / 900}
                />
              </g>
            );
          })}

          {draft && (
            <polygon
              points={rectPolygon(draft.from, draft.to).map((p) => p.join(",")).join(" ")}
              fill="#4bb3fd33"
              stroke="#4bb3fd"
              strokeWidth={view.width / 500}
            />
          )}
        </svg>

        <Inspector
          property={{ ...property, nodes: graphed }}
          selection={selection}
          orphans={orphans}
          onUpdate={update}
          onSelect={setSelection}
        >
          <AddPhotos property={property} onUpdate={update} />
          {/* Only shows itself for a tour that knows where it is, which is
              every tour built from an address and none drawn by hand. */}
          <ReshapeFromSatellite
            property={property}
            onApply={(next) => {
              update(next);
              // The plan has moved wholesale, so what was selected is either
              // somewhere else or gone. Keeping the selection would leave the
              // inspector describing a room that is no longer under it.
              setSelection(null);
              fit();
            }}
          />
        </Inspector>
      </div>

      <footer className="border-t border-ink-600 bg-ink-800 px-4 py-1.5 text-[11px] text-mist-400">
        {tool === "room" && "Drag to draw a room."}
        {tool === "door" && "Click on a wall shared by two rooms to cut a doorway."}
        {tool === "camera" && "Click inside a room to place a viewpoint."}
        {tool === "select" && "Click to select, drag to move. Shift-drag or scroll to pan and zoom."}
        {orphans.length > 0 && (
          <span className="ml-3 text-warn">
            {orphans.length} viewpoint{orphans.length > 1 ? "s" : ""} unreachable - usually a
            missing doorway.
          </span>
        )}
        <span className="ml-3">
          Plan {formatLength(view.width, property.displayUnits)} across
        </span>
      </footer>
    </div>
  );
}

function Grid({ view }: { view: { x: number; y: number; width: number; height: number } }) {
  const lines: React.ReactNode[] = [];

  // The viewBox is square but the element rarely is, so SVG shows more world
  // than the viewBox describes. Drawing a margin of one full view either way
  // guarantees the grid reaches the edges at any window shape.
  const margin = Math.max(view.width, view.height);
  const start = Math.floor((view.x - margin) / GRID_M) * GRID_M;
  const end = view.x + view.width + margin;
  const startY = Math.floor((view.y - margin) / GRID_M) * GRID_M;
  const endY = view.y + view.height + margin;
  const stroke = view.width / 1400;

  // Skip the grid entirely when zoomed out far enough that it would be noise.
  if (view.width / GRID_M > 160) return null;

  for (let x = start; x <= end; x += GRID_M) {
    lines.push(
      <line key={`x${x}`} x1={x} y1={startY} x2={x} y2={endY} stroke="#222b36" strokeWidth={stroke} />,
    );
  }
  for (let y = startY; y <= endY; y += GRID_M) {
    lines.push(
      <line key={`y${y}`} x1={start} y1={y} x2={end} y2={y} stroke="#222b36" strokeWidth={stroke} />,
    );
  }
  return <g style={{ pointerEvents: "none" }}>{lines}</g>;
}
