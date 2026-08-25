"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ROOM_PRESETS, autoOpenings, boundsOf, rectangle, typicalSize } from "@/lib/plan/autolayout";
import { SketchImport } from "@/components/wizard/SketchImport";
import { area, centroid, levelName, levelsOf } from "@/lib/plan/geometry";
import { isStairs } from "@/lib/plan/room-kind";
import type { Plan, Room, Vec2 } from "@/lib/schema";
import { M_PER_FT, formatArea } from "@/lib/units";

/**
 * The layout builder.
 *
 * Everything here is a correction to something the auto-layout can only guess:
 * a hallway runs the other way, the house has an upstairs, there is a corridor
 * nobody photographed. Those are not exotic cases, so they cannot live behind
 * an "advanced" door - a plan you cannot fix is a plan you have to accept.
 *
 * Doorways stay derived from adjacency throughout. Every edit re-derives them,
 * so no edit can leave the plan unwalkable.
 */

const SNAP_M = 0.45;
const NUDGE_M = M_PER_FT / 2;
const MIN_ROOM_M = 1.2;

type Drag =
  | { kind: "move"; roomId: string; grabOffset: Vec2 }
  | { kind: "resize"; roomId: string }
  | null;

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
      if (Math.abs(to - from) < bestX) {
        bestX = Math.abs(to - from);
        dx = to - from;
      }
    }
    for (const [from, to] of [
      [b.y0, o.y0],
      [b.y0, o.y1],
      [b.y1, o.y0],
      [b.y1, o.y1],
    ]) {
      if (Math.abs(to - from) < bestY) {
        bestY = Math.abs(to - from);
        dy = to - from;
      }
    }
  }

  if (dx === 0 && dy === 0) return moved;
  return { ...moved, polygon: moved.polygon.map(([x, y]) => [x + dx, y + dy] as Vec2) };
}

/** Swap a room's width and height about its centre. */
function rotated(room: Room): Room {
  const b = boundsOf(room.polygon);
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  return { ...room, polygon: rectangle(cx - h / 2, cy - w / 2, h, w) };
}

function translated(room: Room, dx: number, dy: number): Room {
  return { ...room, polygon: room.polygon.map(([x, y]) => [x + dx, y + dy] as Vec2) };
}

function nextRoomId(rooms: Room[]): string {
  for (let i = rooms.length + 1; ; i++) {
    const id = `r${i}`;
    if (!rooms.some((r) => r.id === id)) return id;
  }
}

export function PlanBuilder({
  plan,
  photoCounts,
  displayUnits,
  livingAreaSqft,
  onChange,
}: {
  plan: Plan;
  photoCounts: Record<string, number>;
  displayUnits: "ft" | "m";
  /** From a listing, if there was one — used to scale a drawing. */
  livingAreaSqft?: number;
  onChange: (plan: Plan) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [showPalette, setShowPalette] = useState(false);
  const [sketchNotes, setSketchNotes] = useState<string[]>([]);
  const history = useRef<Plan[]>([]);

  const levels = useMemo(() => {
    const used = levelsOf(plan);
    return used.length > 0 ? used : [0];
  }, [plan]);

  const onFloor = useMemo(() => plan.rooms.filter((r) => r.level === level), [plan, level]);
  const otherFloors = useMemo(() => plan.rooms.filter((r) => r.level !== level), [plan, level]);

  /** Every edit re-derives doorways and banks an undo step. */
  const commit = useCallback(
    (rooms: Room[], record = true) => {
      if (record) {
        history.current.push(plan);
        if (history.current.length > 60) history.current.shift();
      }
      onChange({ ...plan, rooms, openings: autoOpenings(rooms) });
    },
    [plan, onChange],
  );

  const undo = useCallback(() => {
    const previous = history.current.pop();
    if (previous) onChange(previous);
  }, [onChange]);

  // The whole plan, not just this floor, so a ghosted storey stays in frame and
  // stairs can be lined up against the floor below.
  const view = useMemo(() => {
    const all = plan.rooms.flatMap((r) => r.polygon);
    if (all.length === 0) return { x: -6, y: -6, size: 12 };
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    const pad = 2.5;
    const x = Math.min(...xs) - pad;
    const y = Math.min(...ys) - pad;
    return {
      x,
      y,
      size: Math.max(Math.max(...xs) - x, Math.max(...ys) - y) + pad,
    };
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

  const patchRoom = (id: string, fn: (room: Room) => Room, record = true) =>
    commit(plan.rooms.map((r) => (r.id === id ? fn(r) : r)), record);

  const addRoom = (label: string) => {
    const [w, h] = typicalSize(label);
    // Drop it beside the current floor rather than on top of it, so it is
    // visible and unattached until the user places it deliberately.
    const b = onFloor.length > 0
      ? onFloor.map((r) => boundsOf(r.polygon)).reduce((acc, r) => ({
          x0: Math.min(acc.x0, r.x0),
          y0: Math.min(acc.y0, r.y0),
          x1: Math.max(acc.x1, r.x1),
          y1: Math.max(acc.y1, r.y1),
        }))
      : { x0: 0, y0: 0, x1: 0, y1: 0 };

    const room: Room = {
      id: nextRoomId(plan.rooms),
      label,
      polygon: rectangle(b.x1 + 1.2, b.y0, w, h),
      ceilingHeight: 2.7,
      level,
    };
    commit([...plan.rooms, room]);
    setSelected(room.id);
    setShowPalette(false);
  };

  const addFloor = () => {
    const next = Math.max(...levels) + 1;
    setLevel(next);
    setShowPalette(true);
  };

  /** Mirror the whole storey - for when the plan came out handed the wrong way. */
  const mirrorFloor = () => {
    if (onFloor.length === 0) return;
    const xs = onFloor.flatMap((r) => r.polygon.map((p) => p[0]));
    const axis = (Math.min(...xs) + Math.max(...xs));
    commit(
      plan.rooms.map((room) => {
        if (room.level !== level) return room;
        const b = boundsOf(room.polygon);
        const width = b.x1 - b.x0;
        return { ...room, polygon: rectangle(axis - b.x1, b.y0, width, b.y1 - b.y0) };
      }),
    );
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const point = toPlan(e.clientX, e.clientY);
    const room = plan.rooms.find((r) => r.id === drag.roomId);
    if (!room) return;
    const b = boundsOf(room.polygon);
    const others = plan.rooms.filter((r) => r.id !== room.id && r.level === room.level);

    if (drag.kind === "move") {
      const moved: Room = {
        ...room,
        polygon: rectangle(
          point[0] - drag.grabOffset[0],
          point[1] - drag.grabOffset[1],
          b.x1 - b.x0,
          b.y1 - b.y0,
        ),
      };
      // Only the gesture's first frame records undo, or a single drag would
      // fill the history with a hundred intermediate positions.
      commit(
        plan.rooms.map((r) => (r.id === room.id ? snapToNeighbours(moved, others) : r)),
        false,
      );
      return;
    }

    const resized: Room = {
      ...room,
      polygon: rectangle(
        b.x0,
        b.y0,
        Math.max(point[0] - b.x0, MIN_ROOM_M),
        Math.max(point[1] - b.y0, MIN_ROOM_M),
      ),
    };
    commit(
      plan.rooms.map((r) => (r.id === room.id ? snapToNeighbours(resized, others) : r)),
      false,
    );
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (!selected) return;
      const room = plan.rooms.find((r) => r.id === selected);
      if (!room) return;

      if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        patchRoom(room.id, rotated);
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        commit(plan.rooms.filter((r) => r.id !== room.id));
        setSelected(null);
      }
      const nudges: Record<string, Vec2> = {
        ArrowLeft: [-NUDGE_M, 0],
        ArrowRight: [NUDGE_M, 0],
        ArrowUp: [0, -NUDGE_M],
        ArrowDown: [0, NUDGE_M],
      };
      const nudge = nudges[e.key];
      if (nudge) {
        e.preventDefault();
        patchRoom(room.id, (r) => translated(r, nudge[0], nudge[1]));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const stranded = useMemo(() => {
    if (plan.rooms.length < 2) return [];
    const linked = new Set(plan.openings.flatMap((o) => o.between));
    return plan.rooms.filter((r) => !linked.has(r.id));
  }, [plan]);

  const selectedRoom = plan.rooms.find((r) => r.id === selected) ?? null;
  const stairsOnFloor = onFloor.some((r) => isStairs(r.label));

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-medium">Build the layout</h2>
          <p className="text-sm text-mist-400">
            Drag rooms together. Touching rooms get a doorway automatically.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={undo}
            className="rounded border border-ink-500 px-2.5 py-1.5 text-xs hover:bg-ink-600"
          >
            Undo
          </button>
          <button
            onClick={mirrorFloor}
            className="rounded border border-ink-500 px-2.5 py-1.5 text-xs hover:bg-ink-600"
          >
            Mirror floor
          </button>
          <SketchImport
            livingAreaSqft={livingAreaSqft}
            onPlan={(next, notes) => {
              history.current.push(plan);
              setSketchNotes(notes);
              setLevel(0);
              setSelected(null);
              onChange(next);
            }}
          />
          <button
            onClick={() => setShowPalette((v) => !v)}
            className="rounded bg-ink-600 px-2.5 py-1.5 text-xs hover:bg-ink-500"
          >
            + Add room
          </button>
        </div>
      </div>

      {/* Storeys */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {levels.map((l) => (
          <button
            key={l}
            onClick={() => setLevel(l)}
            className={`rounded px-3 py-1.5 text-xs transition ${
              l === level
                ? "bg-accent text-ink-900"
                : "border border-ink-500 text-mist-200 hover:bg-ink-600"
            }`}
          >
            {levelName(l)}
            <span className="ml-1.5 opacity-60">
              {plan.rooms.filter((r) => r.level === l).length}
            </span>
          </button>
        ))}
        <button
          onClick={addFloor}
          className="rounded border border-dashed border-ink-500 px-3 py-1.5 text-xs text-mist-400 hover:bg-ink-700"
        >
          + Add floor
        </button>
      </div>

      {sketchNotes.length > 0 && (
        <div className="mb-2 rounded-lg border border-ink-600 bg-ink-800 px-3 py-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-mist-400">
                What it read from your drawing
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-mist-400">
                {sketchNotes.map((note, i) => (
                  <li key={i}>&middot; {note}</li>
                ))}
              </ul>
            </div>
            <button
              onClick={() => setSketchNotes([])}
              className="text-xs text-mist-400 hover:text-mist-200"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {showPalette && (
        <div className="mb-2 rounded-lg border border-ink-600 bg-ink-800 p-2.5">
          <p className="mb-2 text-[11px] text-mist-400">
            Add a room to {levelName(level)}. Rooms with no photos still work &ndash; a hallway
            joins the rooms either side of it.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {ROOM_PRESETS.map((label) => (
              <button
                key={label}
                onClick={() => addRoom(label)}
                className="rounded border border-ink-500 px-2.5 py-1 text-xs hover:border-accent-dim hover:bg-ink-700"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {selectedRoom && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-ink-600 bg-ink-800 px-2.5 py-2">
          <input
            value={selectedRoom.label}
            onChange={(e) => patchRoom(selectedRoom.id, (r) => ({ ...r, label: e.target.value }))}
            className="w-44 rounded border border-ink-600 bg-ink-700 px-2 py-1 text-sm outline-none focus:border-accent-dim"
          />
          <button
            onClick={() => patchRoom(selectedRoom.id, rotated)}
            className="rounded border border-ink-500 px-2.5 py-1 text-xs hover:bg-ink-600"
          >
            Rotate <span className="opacity-50">R</span>
          </button>
          <button
            onClick={() => {
              const copy: Room = {
                ...selectedRoom,
                id: nextRoomId(plan.rooms),
                polygon: translated(selectedRoom, 0.9, 0.9).polygon,
              };
              commit([...plan.rooms, copy]);
              setSelected(copy.id);
            }}
            className="rounded border border-ink-500 px-2.5 py-1 text-xs hover:bg-ink-600"
          >
            Duplicate
          </button>
          {levels.length > 1 && (
            <select
              value={selectedRoom.level}
              onChange={(e) =>
                patchRoom(selectedRoom.id, (r) => ({ ...r, level: Number(e.target.value) }))
              }
              className="rounded border border-ink-600 bg-ink-700 px-2 py-1 text-xs outline-none"
            >
              {levels.map((l) => (
                <option key={l} value={l}>
                  {levelName(l)}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => {
              commit(plan.rooms.filter((r) => r.id !== selectedRoom.id));
              setSelected(null);
            }}
            className="ml-auto rounded border border-ink-500 px-2.5 py-1 text-xs text-warn hover:bg-ink-600"
          >
            Delete
          </button>
        </div>
      )}

      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.size} ${view.size}`}
        className="w-full touch-none rounded-lg border border-ink-600 bg-ink-900"
        style={{ maxHeight: "56vh", aspectRatio: "1" }}
        onPointerMove={onMove}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
        onPointerDown={(e) => {
          if (e.target === svgRef.current) setSelected(null);
        }}
      >
        {/* Storeys below and above, ghosted. Essential for stairs: they connect
            only where their footprints overlap, so you need to see through. */}
        {otherFloors.map((room) => {
          const b = boundsOf(room.polygon);
          return (
            <rect
              key={`ghost-${room.id}`}
              x={b.x0}
              y={b.y0}
              width={b.x1 - b.x0}
              height={b.y1 - b.y0}
              fill="none"
              stroke="#39424f"
              strokeDasharray={`${view.size / 160} ${view.size / 160}`}
              strokeWidth={view.size / 600}
              style={{ pointerEvents: "none" }}
            />
          );
        })}

        {onFloor.map((room) => {
          const b = boundsOf(room.polygon);
          const c = centroid(room.polygon);
          const isSelected = selected === room.id;
          const count = photoCounts[room.label] ?? 0;
          const stairs = isStairs(room.label);
          return (
            <g key={room.id}>
              <rect
                x={b.x0}
                y={b.y0}
                width={b.x1 - b.x0}
                height={b.y1 - b.y0}
                fill={isSelected ? "#2a6f9e66" : stairs ? "#3a2f1acc" : "#262d37cc"}
                stroke={isSelected ? "#4bb3fd" : stairs ? "#f2a541" : "#4a5566"}
                strokeWidth={view.size / 400}
                style={{ cursor: "grab" }}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const point = toPlan(e.clientX, e.clientY);
                  setSelected(room.id);
                  history.current.push(plan);
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
                fontSize={view.size / 45}
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                {room.label}
              </text>
              <text
                x={c[0]}
                y={c[1] + view.size / 50}
                textAnchor="middle"
                fill="#8a95a3"
                fontSize={view.size / 68}
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                {formatArea(area(room.polygon), displayUnits)}
                {count > 0 && ` · ${count} photo${count === 1 ? "" : "s"}`}
              </text>

              <rect
                x={b.x1 - view.size / 55}
                y={b.y1 - view.size / 55}
                width={view.size / 55}
                height={view.size / 55}
                fill={isSelected ? "#4bb3fd" : "#4a5566"}
                style={{ cursor: "nwse-resize" }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setSelected(room.id);
                  history.current.push(plan);
                  setDrag({ kind: "resize", roomId: room.id });
                }}
              />
            </g>
          );
        })}

        {plan.openings
          .filter((o) => {
            const rooms = o.between.map((id) => plan.rooms.find((r) => r.id === id));
            return rooms.some((r) => r?.level === level);
          })
          .map((opening) => (
            <circle
              key={opening.id}
              cx={opening.at[0]}
              cy={opening.at[1]}
              r={view.size / (opening.kind === "stairs" ? 90 : 130)}
              fill="#0b0d10"
              stroke={opening.kind === "stairs" ? "#7ee787" : "#f2a541"}
              strokeWidth={view.size / 400}
              style={{ pointerEvents: "none" }}
            />
          ))}
      </svg>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-mist-400">
        <span>
          Click a room to rotate, rename or delete it. Arrow keys nudge, ⌘Z undoes.
        </span>
        <span>
          {plan.openings.filter((o) => o.kind === "door").length} doorways
          {plan.openings.some((o) => o.kind === "stairs") &&
            ` · ${plan.openings.filter((o) => o.kind === "stairs").length} stairs`}
        </span>
      </div>

      {levels.length > 1 && !stairsOnFloor && (
        <p className="mt-2 rounded border border-ink-600 bg-ink-800 px-3 py-2 text-xs text-mist-400">
          To join floors, put a <strong className="text-mist-200">Stairs</strong> room in the
          same spot on both. The dashed outlines show the other floor, so you can line them up.
        </p>
      )}

      {stranded.length > 0 && (
        <p className="mt-2 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          {stranded.map((r) => r.label).join(", ")} {stranded.length === 1 ? "is" : "are"} not
          touching anything, so {stranded.length === 1 ? "it has" : "they have"} no way in. Drag{" "}
          {stranded.length === 1 ? "it" : "them"} against a neighbour.
        </p>
      )}
    </div>
  );
}
