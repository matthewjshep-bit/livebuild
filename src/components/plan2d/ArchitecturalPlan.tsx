"use client";

import { useMemo, useRef, useState } from "react";

import { usePlanView } from "@/components/editor/usePlanView";
import type { Pick } from "@/lib/bom/pickable";
import { piecesFor } from "@/lib/model/staging";
import type { HouseSpec } from "@/lib/spec/schema";
import { runsAtLevel, stairSymbol } from "@/lib/model/stairs";
import { wallsForLevel } from "@/lib/model/walls";
import { windowsForLevel } from "@/lib/model/windows";
import { boundsOf } from "@/lib/plan/autolayout";
import { area, centroid, levelName } from "@/lib/plan/geometry";
import { planFromBearing } from "@/lib/model/sun";
import type { Plan, Site, Vec2 } from "@/lib/schema";
import { formatArea } from "@/lib/units";

/**
 * The plan as an architect draws it.
 *
 * Every other 2D surface in this app draws a room as a filled rectangle with a
 * hairline round it - a diagram, and one that does not know what a wall is. The
 * model has known for some time: `wallsForLevel` returns wall rectangles with
 * real thickness and the doorways already subtracted, and the pieces it emits
 * above each opening *are* the doorway rectangles, which is the cleanest
 * possible source for a door swing. Windows and furniture are equally derived.
 * So this is presentation over data that already exists.
 *
 * One deliberate departure from every other drawing here: line weights are set
 * per element rather than as one fraction of the view. A drawing is read by its
 * hierarchy - walls heavier than furniture, furniture heavier than dimensions -
 * and a single global stroke width cannot express that.
 */

/** Line weights in metres, so they scale with the drawing rather than the page. */
const WEIGHT = {
  wall: 0.03,
  door: 0.02,
  window: 0.022,
  furniture: 0.018,
  stair: 0.018,
};

const INK = {
  poche: "#d8d5cf",
  pocheEdge: "#6f6b64",
  paper: "#12161b",
  door: "#8a95a3",
  window: "#7fb3d5",
  furniture: "#5d6673",
  text: "#c9d1dc",
  faint: "#5a6472",
  selected: "#4bb3fd",
};

export function ArchitecturalPlan({
  plan,
  site,
  level,
  levels,
  onLevel,
  displayUnits,
  pick,
  onPick,
  furnished = false,
  spec = null,
}: {
  plan: Plan;
  site: Site | null | undefined;
  level: number;
  levels: number[];
  onLevel: (level: number) => void;
  displayUnits: "ft" | "m";
  pick: Pick | null;
  onPick?: (pick: Pick) => void;
  /** Staging. Off leaves the fixtures - a plan with no WC is not a plan. */
  furnished?: boolean;
  /** So the drawing suppresses the same duplicates the model does. */
  spec?: HouseSpec | null;
}) {
  const { svgRef, view, toPlan, zoomAt, panBy, fit } = usePlanView(plan);
  const dragging = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const [hover, setHover] = useState<string | null>(null);

  const rooms = useMemo(() => plan.rooms.filter((r) => r.level === level), [plan, level]);
  const walls = useMemo(() => wallsForLevel(plan, level), [plan, level]);
  const windows = useMemo(() => windowsForLevel(plan, level), [plan, level]);
  const runs = useMemo(() => runsAtLevel(plan, level), [plan, level]);

  // Solid wall and the pieces above the doorways, which are the doorways.
  const solidWalls = walls.filter((w) => !w.header);
  const doorways = walls.filter((w) => w.header);

  const rectOf = (w: (typeof walls)[number]) => {
    const alongX = Math.abs(w.angleDeg) < 45;
    const halfW = (alongX ? w.length : w.thickness) / 2;
    const halfD = (alongX ? w.thickness : w.length) / 2;
    return {
      x: w.center[0] - halfW,
      y: w.center[1] - halfD,
      w: halfW * 2,
      h: halfD * 2,
      alongX,
    };
  };

  const north = site ? planFromBearing(site, 0) : null;

  return (
    <div className="relative h-full w-full bg-ink-900">
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
        className="h-full w-full touch-none"
        onWheel={(e) => zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.1 : 1 / 1.1)}
        onPointerDown={(e) => {
          dragging.current = true;
          last.current = { x: e.clientX, y: e.clientY };
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          panBy(e.clientX - last.current.x, e.clientY - last.current.y);
          last.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
      >
        {/* Floors first, so everything else sits on them. */}
        {rooms.map((room) => {
          const b = boundsOf(room.polygon);
          const selected = pick?.roomId === room.id;
          return (
            <rect
              key={room.id}
              x={b.x0}
              y={b.y0}
              width={b.x1 - b.x0}
              height={b.y1 - b.y0}
              fill={selected ? "#1d3346" : hover === room.id ? "#1b2430" : "#161b22"}
              onClick={() => onPick?.({ roomId: room.id, element: null })}
              onPointerEnter={() => setHover(room.id)}
              onPointerLeave={() => setHover((h) => (h === room.id ? null : h))}
              style={{ cursor: onPick ? "pointer" : "default" }}
            />
          );
        })}

        {/* Poché: the walls in solid, which is what makes it read as a plan. */}
        {solidWalls.map((w, i) => {
          const r = rectOf(w);
          return (
            <rect
              key={`w${i}`}
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              fill={INK.poche}
              stroke={INK.pocheEdge}
              strokeWidth={WEIGHT.wall / 3}
            />
          );
        })}

        {/* Doors, drawn from the pieces above them: a leaf and its swing. */}
        {doorways.map((w, i) => {
          const r = rectOf(w);
          const width = r.alongX ? r.w : r.h;
          const hinge: Vec2 = r.alongX ? [r.x, r.y + r.h / 2] : [r.x + r.w / 2, r.y];
          const leaf: Vec2 = r.alongX ? [r.x, r.y + r.h / 2 - width] : [r.x + r.w / 2 + width, r.y];
          const openTo: Vec2 = r.alongX ? [r.x + width, r.y + r.h / 2] : [r.x + r.w / 2, r.y + width];
          return (
            <g key={`d${i}`} stroke={INK.door} strokeWidth={WEIGHT.door} fill="none">
              {/* The gap itself, cleared through the poché. */}
              <rect
                x={r.x}
                y={r.y}
                width={r.w}
                height={r.h}
                fill={INK.paper}
                stroke="none"
              />
              <line x1={hinge[0]} y1={hinge[1]} x2={leaf[0]} y2={leaf[1]} />
              <path
                d={`M ${leaf[0]} ${leaf[1]} A ${width} ${width} 0 0 1 ${openTo[0]} ${openTo[1]}`}
                strokeWidth={WEIGHT.door / 1.6}
                opacity={0.7}
              />
            </g>
          );
        })}

        {/* Windows: the conventional pane line across the wall. */}
        {windows.map((win, i) => {
          const alongX = Math.abs(win.angleDeg) < 45;
          const half = win.width / 2;
          const t = win.thickness / 2;
          return (
            <g key={`win${i}`} stroke={INK.window} strokeWidth={WEIGHT.window} fill={INK.paper}>
              <rect
                x={win.center[0] - (alongX ? half : t)}
                y={win.center[1] - (alongX ? t : half)}
                width={alongX ? win.width : win.thickness}
                height={alongX ? win.thickness : win.width}
                stroke="none"
              />
              <line
                x1={win.center[0] - (alongX ? half : 0)}
                y1={win.center[1] - (alongX ? 0 : half)}
                x2={win.center[0] + (alongX ? half : 0)}
                y2={win.center[1] + (alongX ? 0 : half)}
              />
            </g>
          );
        })}

        {/* Furniture in outline, so it reads as an arrangement not an object. */}
        {rooms.map((room) => {
          const b = boundsOf(room.polygon);
          return piecesFor(plan, room, furnished, spec?.rooms[room.id]).flatMap((piece, pi) =>
            piece.boxes.map((box, bi) => (
              <rect
                key={`f${room.id}-${pi}-${bi}`}
                x={b.x0 + box.center[0] - box.size[0] / 2}
                y={b.y0 + box.center[2] - box.size[2] / 2}
                width={box.size[0]}
                height={box.size[2]}
                fill="none"
                stroke={INK.furniture}
                strokeWidth={WEIGHT.furniture}
                pointerEvents="none"
              />
            )),
          );
        })}

        {/* The staircase, with its treads and the conventional break. */}
        {[runs.up, runs.down].map((run, ri) => {
          if (!run) return null;
          const sym = stairSymbol(run, level);
          if (!sym) return null;
          return (
            <g key={`s${ri}`} pointerEvents="none">
              {sym.outlines.map((r, i) => (
                <rect
                  key={i}
                  x={r.x0}
                  y={r.y0}
                  width={r.x1 - r.x0}
                  height={r.y1 - r.y0}
                  fill="none"
                  stroke={INK.faint}
                  strokeWidth={WEIGHT.stair}
                />
              ))}
              {sym.treadLines.map(([a, c], i) => (
                <line
                  key={`t${i}`}
                  x1={a[0]}
                  y1={a[1]}
                  x2={c[0]}
                  y2={c[1]}
                  stroke={INK.faint}
                  strokeWidth={WEIGHT.stair}
                />
              ))}
              {sym.breakLine && (
                <line
                  x1={sym.breakLine[0][0]}
                  y1={sym.breakLine[0][1]}
                  x2={sym.breakLine[1][0]}
                  y2={sym.breakLine[1][1]}
                  stroke={INK.text}
                  strokeWidth={WEIGHT.stair}
                  strokeDasharray={`${view.width / 90} ${view.width / 140}`}
                />
              )}
              <line
                x1={sym.arrow.from[0]}
                y1={sym.arrow.from[1]}
                x2={sym.arrow.to[0]}
                y2={sym.arrow.to[1]}
                stroke={INK.text}
                strokeWidth={WEIGHT.stair}
              />
              <text
                x={(sym.arrow.from[0] + sym.arrow.to[0]) / 2}
                // Set below the run rather than on it: a stairwell is small and
                // the label lands on the room's own name otherwise.
                y={(sym.arrow.from[1] + sym.arrow.to[1]) / 2 + view.width / 22}
                textAnchor="middle"
                fill={INK.text}
                fontSize={view.width / 70}
              >
                {sym.arrow.label}
              </text>
            </g>
          );
        })}

        {/* Names and areas, which is what a plan is read for. */}
        {rooms.map((room) => {
          const c = centroid(room.polygon);
          return (
            <g key={`l${room.id}`} pointerEvents="none" textAnchor="middle">
              <text
                x={c[0]}
                y={c[1]}
                fill={pick?.roomId === room.id ? INK.selected : INK.text}
                fontSize={view.width / 48}
                style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}
              >
                {room.label}
              </text>
              <text x={c[0]} y={c[1] + view.width / 40} fill={INK.faint} fontSize={view.width / 72}>
                {formatArea(area(room.polygon), displayUnits)}
              </text>
            </g>
          );
        })}

        {/* North, which we know for real when the house came from an address. */}
        {north && (
          <g pointerEvents="none" transform={`translate(${view.x + view.width * 0.9}, ${view.y + view.height * 0.12})`}>
            <line
              x1={0}
              y1={0}
              x2={north[0] * view.width * 0.05}
              y2={north[1] * view.width * 0.05}
              stroke={INK.text}
              strokeWidth={WEIGHT.wall / 2}
            />
            <text
              x={north[0] * view.width * 0.07}
              y={north[1] * view.width * 0.07}
              fill={INK.text}
              fontSize={view.width / 60}
              textAnchor="middle"
            >
              N
            </text>
          </g>
        )}
      </svg>

      <div className="absolute top-3 left-3 flex items-center gap-1.5">
        {levels.length > 1 &&
          levels.map((l) => (
            <button
              key={l}
              onClick={() => onLevel(l)}
              className={`rounded px-2.5 py-1 text-xs transition ${
                l === level
                  ? "bg-accent text-ink-900"
                  : "border border-ink-500 text-mist-200 hover:bg-ink-600"
              }`}
            >
              {levelName(l)}
            </button>
          ))}
        <button
          onClick={fit}
          className="rounded border border-ink-500 px-2.5 py-1 text-xs text-mist-200 hover:bg-ink-600"
        >
          Fit
        </button>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-ink-800/85 px-3 py-1.5 text-[11px] text-mist-400 backdrop-blur">
        Drag to pan · scroll to zoom · click a room for its scope
      </div>
    </div>
  );
}
