"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ROOM_PRESETS, autoOpenings, boundsOf, rectangle, typicalSize } from "@/lib/plan/autolayout";
import { area, centroid, levelName, levelsOf } from "@/lib/plan/geometry";
import { isStairs } from "@/lib/plan/room-kind";
import type { DrawnCheck } from "@/lib/plan/drawn";
import type { Plan, Room, Vec2 } from "@/lib/schema";
import { M_PER_FT, formatArea, formatFeetInches, ftToM, mToFt } from "@/lib/units";

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

/**
 * Walls land on six inches, the way the rest of the plan already does.
 *
 * Dragging was free-form to a float, so no amount of care produced a wall at a
 * number anybody would write down - a room came out 3.87 m wide because that is
 * where the mouse stopped. The sketch solver has always rounded to this, and
 * `prepareFootprint` snaps the building outline to two feet, so this is the
 * plan agreeing with itself rather than a new opinion.
 *
 * Applied before the neighbour snap, never after: rooms touching exactly is
 * what doorways are derived from, and a grid applied last would push them a
 * few millimetres apart again.
 */
const GRID_M = M_PER_FT / 2;

const onGrid = (value: number) => Math.round(value / GRID_M) * GRID_M;

type Drag =
  | { kind: "move"; roomId: string; grabOffset: Vec2 }
  | { kind: "resize"; roomId: string }
  | null;

/** Put a room's corners on the grid, keeping its shape a rectangle. */
function snapToGrid(room: Room): Room {
  const b = boundsOf(room.polygon);
  return {
    ...room,
    polygon: rectangle(
      onGrid(b.x0),
      onGrid(b.y0),
      Math.max(GRID_M, onGrid(b.x1 - b.x0)),
      Math.max(GRID_M, onGrid(b.y1 - b.y0)),
    ),
  };
}

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

/**
 * A room's dimensions, in feet, typed.
 *
 * Held locally while it is being edited so that "1" on the way to "12" does not
 * collapse the room to a foot wide and take its neighbours with it; committed
 * on blur and on Enter, and re-synced whenever the room changes underneath -
 * which it does on every drag.
 */
function Size({
  room,
  onChange,
}: {
  room: Room;
  onChange: (widthM: number, depthM: number) => void;
}) {
  const b = boundsOf(room.polygon);
  const asText = (m: number) => String(Math.round(mToFt(m) * 10) / 10);
  const [draft, setDraft] = useState<{ w: string; d: string }>({
    w: asText(b.x1 - b.x0),
    d: asText(b.y1 - b.y0),
  });

  useEffect(() => {
    const bounds = boundsOf(room.polygon);
    setDraft({ w: asText(bounds.x1 - bounds.x0), d: asText(bounds.y1 - bounds.y0) });
  }, [room]);

  const commitSize = (next: { w: string; d: string }) => {
    const width = Number(next.w);
    const depth = Number(next.d);
    if (!Number.isFinite(width) || !Number.isFinite(depth)) return;
    onChange(Math.max(MIN_ROOM_M, ftToM(width)), Math.max(MIN_ROOM_M, ftToM(depth)));
  };

  const field =
    "w-16 rounded border border-ink-600 bg-ink-700 px-2 py-1 text-sm tabular-nums outline-none focus:border-accent-dim";

  return (
    <span className="flex items-center gap-1 text-xs text-mist-400">
      <input
        type="number"
        step={0.5}
        min={1}
        value={draft.w}
        aria-label="Width in feet"
        data-testid="room-width"
        onChange={(e) => setDraft((d) => ({ ...d, w: e.target.value }))}
        onBlur={() => commitSize(draft)}
        onKeyDown={(e) => e.key === "Enter" && commitSize(draft)}
        className={field}
      />
      <span aria-hidden>&times;</span>
      <input
        type="number"
        step={0.5}
        min={1}
        value={draft.d}
        aria-label="Depth in feet"
        data-testid="room-depth"
        onChange={(e) => setDraft((d) => ({ ...d, d: e.target.value }))}
        onBlur={() => commitSize(draft)}
        onKeyDown={(e) => e.key === "Enter" && commitSize(draft)}
        className={field}
      />
      <span>ft</span>
    </span>
  );
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
  boundary,
  check,
  backdrop,
  unplaced,
  adjacency,
  showHeading = true,
  onChange,
}: {
  plan: Plan;
  photoCounts: Record<string, number>;
  displayUnits: "ft" | "m";
  /**
   * The building's measured outline, when there is one.
   *
   * Drawn heavily and always kept in frame, because when it is present it is
   * the thing being drawn inside rather than a decoration. Absent for a tour
   * with no site, where free dragging is the only sensible tool and always was.
   */
  boundary?: Vec2[] | null;
  /**
   * What is wrong with the drawing right now, shaded as you work.
   *
   * The check itself lives with whoever owns the gate; this only draws it.
   * Showing faults continuously is what keeps "rejected, never repaired"
   * humane - nobody should reach the end of a layout and be told no.
   */
  check?: DrawnCheck | null;
  /**
   * The satellite image, already placed in plan coordinates.
   *
   * Plain numbers rather than a component, so the drawing surface does no
   * fetching and the arithmetic that positions it stays in `site/frame.ts`
   * where it is round-tripped by a test.
   */
  backdrop?: { href: string; x: number; y: number; size: number; transform: string } | null;
  /** Rooms the house is known to have that are not on the plan yet. */
  unplaced?: string[];
  /** Pairs seen through an opening in the photographs. */
  adjacency?: Array<[string, string]>;
  /**
   * Whether to print its own title.
   *
   * On the review screen this is one panel among several and needs to say what
   * it is. On the layout stage it is the entire screen and the page has already
   * said so - two headings a line apart read as a bug.
   */
  showHeading?: boolean;
  onChange: (plan: Plan) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [showPalette, setShowPalette] = useState(false);
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
    // The boundary counts even when nothing is drawn yet, which is the whole
    // of the empty-canvas case: an outline you cannot see is one you cannot
    // draw inside.
    const all = [...plan.rooms.flatMap((r) => r.polygon), ...(boundary ?? [])];
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
  }, [plan.rooms, boundary]);

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

    /**
     * Where a new room lands.
     *
     * Beside the others, so it is visibly unattached until placed on purpose.
     * But on an empty floor with a boundary that rule would drop the first
     * room of the house outside the house, which reads as a bug rather than as
     * an invitation - so the first one starts in the building's own corner.
     */
    const at: Vec2 =
      onFloor.length === 0 && boundary && boundary.length > 0
        ? [Math.min(...boundary.map((p) => p[0])), Math.min(...boundary.map((p) => p[1]))]
        : [b.x1 + 1.2, b.y0];

    const room: Room = {
      id: nextRoomId(plan.rooms),
      label,
      polygon: rectangle(at[0], at[1], w, h),
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
        plan.rooms.map((r) => (r.id === room.id ? snapToNeighbours(snapToGrid(moved), others) : r)),
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
      plan.rooms.map((r) => (r.id === room.id ? snapToNeighbours(snapToGrid(resized), others) : r)),
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
          {showHeading && (
            <>
              <h2 className="text-lg font-medium">Build the layout</h2>
              <p className="text-sm text-mist-400">
                Drag rooms together. Touching rooms get a doorway automatically.
              </p>
            </>
          )}
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
          {/* A room is a size before it is a rectangle on a photograph.
              Dragging can now only land on six inches, but "twelve and a half
              feet" is still a thing to be typed rather than aimed at - and it
              is how somebody transcribes a measurement they actually took. The
              top-left corner is held so a room grows away from its neighbours
              rather than sliding out from under them. */}
          <Size
            room={selectedRoom}
            onChange={(width, depth) =>
              patchRoom(selectedRoom.id, (r) => {
                const b = boundsOf(r.polygon);
                return { ...r, polygon: rectangle(b.x0, b.y0, width, depth) };
              })
            }
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
        {/* The ground the house stands on. Dimmed hard: it is there to place
            the building against, and a bright aerial photograph competes with
            the drawing it is supposed to be helping. */}
        {backdrop && (
          <g transform={backdrop.transform} style={{ pointerEvents: "none" }}>
            <image
              href={backdrop.href}
              x={backdrop.x}
              y={backdrop.y}
              width={backdrop.size}
              height={backdrop.size}
              opacity={0.55}
              preserveAspectRatio="none"
            />
          </g>
        )}

        {/* The building, when it is measured. Drawn first and beneath
            everything, and never interactive - it is the constraint, not a
            thing to be dragged. */}
        {boundary && boundary.length > 2 && (
          <polygon
            points={boundary.map((p) => `${p[0]},${p[1]}`).join(" ")}
            // Filled only when there is nothing underneath. Over a satellite
            // image the fill would hide the very thing it is drawn against.
            fill={backdrop ? "#11161d55" : "#11161d"}
            stroke={backdrop ? "#ffd166" : "#7d8899"}
            strokeWidth={view.size / 220}
            style={{ pointerEvents: "none" }}
          />
        )}

        {/* What is wrong, shaded where it is wrong. A gap is the common one and
            the only one a careful person still hits: it means a piece of the
            house belongs to no room, and a room with no walls touching it gets
            no doorways and cannot be walked into. */}
        {check &&
          !check.ok &&
          [
            ...check.gaps.map((r) => ({ r, fill: "#f2a54133", stroke: "#f2a541" })),
            ...check.overlaps.map((r) => ({ r, fill: "#e5484d33", stroke: "#e5484d" })),
            ...check.overhangs.map((r) => ({ r, fill: "#e5484d33", stroke: "#e5484d" })),
          ].map(({ r, fill, stroke }, i) => (
            <rect
              key={`fault-${i}`}
              x={r.x0}
              y={r.y0}
              width={r.x1 - r.x0}
              height={r.y1 - r.y0}
              fill={fill}
              stroke={stroke}
              strokeDasharray={`${view.size / 120} ${view.size / 200}`}
              strokeWidth={view.size / 500}
              style={{ pointerEvents: "none" }}
            />
          ))}

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
              {/* What the room measures, while it is being changed. Reading a
                  size off the room you are dragging is how somebody hits a
                  number on purpose; an area alone never tells you which of the
                  two edges just moved. */}
              {drag?.roomId === room.id && (
                <text
                  x={c[0]}
                  y={b.y0 - view.size / 120}
                  textAnchor="middle"
                  fill="#4bb3fd"
                  fontSize={view.size / 60}
                  style={{ pointerEvents: "none", userSelect: "none" }}
                >
                  {formatFeetInches(b.x1 - b.x0)} × {formatFeetInches(b.y1 - b.y0)}
                </text>
              )}

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

      {/* Why the drawing is not finished, in the same words the shading uses. */}
      {check && !check.ok && (
        <p
          data-testid="layout-fault"
          className="mt-2 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
        >
          {check.why}
        </p>
      )}

      {/*
        The rooms the house is known to have and the drawing does not.
        This is what makes the stage guidance rather than homework: the bed and
        bath count came off the listing and is never wrong, so a room on this
        list is a room that exists whether or not anybody photographed it.
      */}
      {unplaced && unplaced.length > 0 && (
        <div className="mt-2 rounded border border-ink-600 bg-ink-800 px-3 py-2">
          <p className="text-xs text-mist-400">
            Still to place — {unplaced.length} room{unplaced.length === 1 ? "" : "s"} the house is
            known to have:
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {unplaced.map((label) => (
              <button
                key={label}
                data-testid="unplaced-room"
                onClick={() => addRoom(label)}
                className="rounded border border-ink-500 px-2 py-1 text-xs hover:bg-ink-600"
              >
                + {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/*
        Rooms seen through an opening in the photographs, and whether the
        drawing agrees. Never a gate: the outline is measured and the
        photographs are not, so a pair that cannot be made to touch inside the
        real building is the conflict being flagged rather than an error.
      */}
      {adjacency && adjacency.length > 0 && (
        <div className="mt-2 rounded border border-ink-600 bg-ink-800 px-3 py-2">
          <p className="text-xs text-mist-400">Seen connected in the photos:</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {adjacency.map(([a, b]) => {
              const met = plan.openings.some((o) => {
                const first = plan.rooms.find((r) => r.id === o.between[0])?.label;
                const second = plan.rooms.find((r) => r.id === o.between[1])?.label;
                return (
                  (first === a && second === b) || (first === b && second === a)
                );
              });
              return (
                <span
                  key={`${a}|${b}`}
                  className={`rounded border px-2 py-1 text-xs ${
                    met
                      ? "border-ink-500 text-mist-400"
                      : "border-warn/40 bg-warn/10 text-warn"
                  }`}
                >
                  {met ? "✓" : "·"} {a} — {b}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
