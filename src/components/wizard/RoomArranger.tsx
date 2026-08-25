"use client";

import { useMemo, useRef, useState } from "react";

import { autoOpenings, boundsOf, rectangle } from "@/lib/plan/autolayout";
import { area, centroid } from "@/lib/plan/geometry";
import type { Plan, Room, Vec2 } from "@/lib/schema";
import { formatArea } from "@/lib/units";

/**
 * Step three: arrange the rooms.
 *
 * The layout arrives already built and already connected, so the task is
 * "drag this until it looks like your house" rather than "draw your house".
 * Nothing here can produce an unwalkable plan: doorways are re-derived from
 * adjacency on every move, so rooms that touch are always connected and the
 * user never has to think about doors at all.
 */

const SNAP_M = 0.45;
const MIN_ROOM_M = 1.5;

type Drag =
  | { kind: "move"; roomId: string; grabOffset: Vec2 }
  | { kind: "resize"; roomId: string }
  | null;

/**
 * Nudge a dragged room so its edges line up with its neighbours'.
 *
 * Without this, rooms land a few centimetres apart, no doorway is derived, and
 * the tour silently loses a connection. Snapping makes touching the default
 * outcome instead of a lucky one.
 */
function snapToNeighbours(moved: Room, others: Room[]): Room {
  const b = boundsOf(moved.polygon);
  let dx = 0;
  let dy = 0;
  let bestX = SNAP_M;
  let bestY = SNAP_M;

  for (const other of others) {
    const o = boundsOf(other.polygon);
    for (const [from, to] of [
      [b.x0, o.x0],
      [b.x0, o.x1],
      [b.x1, o.x0],
      [b.x1, o.x1],
    ]) {
      const delta = to - from;
      if (Math.abs(delta) < bestX) {
        bestX = Math.abs(delta);
        dx = delta;
      }
    }
    for (const [from, to] of [
      [b.y0, o.y0],
      [b.y0, o.y1],
      [b.y1, o.y0],
      [b.y1, o.y1],
    ]) {
      const delta = to - from;
      if (Math.abs(delta) < bestY) {
        bestY = Math.abs(delta);
        dy = delta;
      }
    }
  }

  if (dx === 0 && dy === 0) return moved;
  return {
    ...moved,
    polygon: moved.polygon.map(([x, y]) => [x + dx, y + dy] as Vec2),
  };
}

export function RoomArranger({
  plan,
  photoCounts,
  displayUnits,
  onChange,
}: {
  plan: Plan;
  photoCounts: Record<string, number>;
  displayUnits: "ft" | "m";
  onChange: (plan: Plan) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [active, setActive] = useState<string | null>(null);

  const view = useMemo(() => {
    const all = plan.rooms.flatMap((r) => r.polygon);
    if (all.length === 0) return { x: 0, y: 0, size: 12 };
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    const pad = 2.5;
    const x0 = Math.min(...xs) - pad;
    const y0 = Math.min(...ys) - pad;
    const size = Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0) + pad;
    return { x: x0, y: y0, size };
  }, [plan.rooms]);

  const toPlan = (clientX: number, clientY: number): Vec2 => {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const rect = svg.getBoundingClientRect();
    return [
      view.x + ((clientX - rect.left) / rect.width) * view.size,
      view.y + ((clientY - rect.top) / rect.height) * view.size,
    ];
  };

  const commit = (rooms: Room[]) => {
    // Doorways are derived, never stored by hand, so a move can never leave
    // them stale.
    onChange({ ...plan, rooms, openings: autoOpenings(rooms) });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const point = toPlan(e.clientX, e.clientY);
    const room = plan.rooms.find((r) => r.id === drag.roomId);
    if (!room) return;
    const b = boundsOf(room.polygon);

    if (drag.kind === "move") {
      const x = point[0] - drag.grabOffset[0];
      const y = point[1] - drag.grabOffset[1];
      const moved: Room = {
        ...room,
        polygon: rectangle(x, y, b.x1 - b.x0, b.y1 - b.y0),
      };
      const snapped = snapToNeighbours(moved, plan.rooms.filter((r) => r.id !== room.id));
      commit(plan.rooms.map((r) => (r.id === room.id ? snapped : r)));
      return;
    }

    const width = Math.max(point[0] - b.x0, MIN_ROOM_M);
    const height = Math.max(point[1] - b.y0, MIN_ROOM_M);
    const resized: Room = { ...room, polygon: rectangle(b.x0, b.y0, width, height) };
    commit(
      plan.rooms.map((r) =>
        r.id === room.id
          ? snapToNeighbours(resized, plan.rooms.filter((o) => o.id !== room.id))
          : r,
      ),
    );
  };

  const connected = useMemo(() => {
    const ids = new Set(plan.openings.flatMap((o) => o.between));
    return plan.rooms.filter((r) => plan.rooms.length > 1 && !ids.has(r.id));
  }, [plan]);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <h2 className="text-lg font-medium">Arrange the rooms</h2>
          <p className="text-sm text-mist-400">
            Drag them until it looks like your house. Rooms that touch get a doorway
            automatically.
          </p>
        </div>
        <span className="text-xs text-mist-400">
          {plan.openings.length} doorway{plan.openings.length === 1 ? "" : "s"}
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.size} ${view.size}`}
        className="w-full touch-none rounded-lg border border-ink-600 bg-ink-900"
        style={{ maxHeight: "62vh", aspectRatio: "1" }}
        onPointerMove={onMove}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
      >
        {plan.rooms.map((room) => {
          const b = boundsOf(room.polygon);
          const c = centroid(room.polygon);
          const isActive = active === room.id;
          const count = photoCounts[room.label] ?? 0;
          return (
            <g key={room.id}>
              <rect
                x={b.x0}
                y={b.y0}
                width={b.x1 - b.x0}
                height={b.y1 - b.y0}
                fill={isActive ? "#2a6f9e66" : "#262d37cc"}
                stroke={isActive ? "#4bb3fd" : "#4a5566"}
                strokeWidth={view.size / 400}
                style={{ cursor: "grab" }}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const point = toPlan(e.clientX, e.clientY);
                  setActive(room.id);
                  setDrag({
                    kind: "move",
                    roomId: room.id,
                    grabOffset: [point[0] - b.x0, point[1] - b.y0],
                  });
                }}
              />
              <text
                x={c[0]}
                y={c[1] - view.size / 90}
                textAnchor="middle"
                fill="#e6ebf2"
                fontSize={view.size / 42}
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                {room.label}
              </text>
              <text
                x={c[0]}
                y={c[1] + view.size / 48}
                textAnchor="middle"
                fill="#8a95a3"
                fontSize={view.size / 65}
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                {formatArea(area(room.polygon), displayUnits)}
                {count > 0 && ` · ${count} photo${count === 1 ? "" : "s"}`}
              </text>

              {/* Resize grip, bottom-right. */}
              <rect
                x={b.x1 - view.size / 55}
                y={b.y1 - view.size / 55}
                width={view.size / 55}
                height={view.size / 55}
                fill={isActive ? "#4bb3fd" : "#4a5566"}
                style={{ cursor: "nwse-resize" }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setActive(room.id);
                  setDrag({ kind: "resize", roomId: room.id });
                }}
              />
            </g>
          );
        })}

        {plan.openings.map((opening) => (
          <circle
            key={opening.id}
            cx={opening.at[0]}
            cy={opening.at[1]}
            r={view.size / 130}
            fill="#0b0d10"
            stroke="#f2a541"
            strokeWidth={view.size / 400}
            style={{ pointerEvents: "none" }}
          />
        ))}
      </svg>

      {connected.length > 0 && (
        <p className="mt-3 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          {connected.map((r) => r.label).join(", ")} {connected.length === 1 ? "is" : "are"} not
          touching any other room, so {connected.length === 1 ? "it has" : "they have"} no
          doorway. Drag {connected.length === 1 ? "it" : "them"} against a neighbour.
        </p>
      )}
    </div>
  );
}
