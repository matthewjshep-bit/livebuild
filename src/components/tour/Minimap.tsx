"use client";

import { useEffect, useMemo, useState } from "react";

import { boundsOf } from "@/lib/plan/autolayout";
import { headingToPlanDir, levelName, levelsOf } from "@/lib/plan/geometry";
import type { Property } from "@/lib/schema";

/**
 * A floor plan in the corner, showing where you are.
 *
 * Inside a room you can only see the rings in front of you, so getting to a
 * room behind you means turning around to look for a door - fine once you know
 * the house, disorienting the first time. The minimap makes every room one
 * click away and, more importantly, tells you where you currently are.
 */
export function Minimap({
  property,
  activeNodeId,
  onlyLevel,
  onSelectNode,
}: {
  property: Property;
  activeNodeId: string | null;
  /** Storey the dollhouse is filtered to, when not inside a room. */
  onlyLevel?: number | null;
  onSelectNode: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  /**
   * A storey the viewer has chosen to look at, which need not be the one they
   * are standing on. Without this the map can only ever show the floor you are
   * already on, so the rooms you cannot see are also the ones you cannot
   * navigate to - the exact case the map exists for.
   */
  const [browsing, setBrowsing] = useState<number | null>(null);

  const view = useMemo(() => {
    const all = property.plan.rooms.flatMap((r) => r.polygon);
    if (all.length === 0) return null;
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    const pad = 0.6;
    const x = Math.min(...xs) - pad;
    const y = Math.min(...ys) - pad;
    return {
      x,
      y,
      width: Math.max(...xs) - x + pad,
      height: Math.max(...ys) - y + pad,
    };
  }, [property.plan.rooms]);

  if (!view) return null;

  const active = property.nodes.find((n) => n.id === activeNodeId) ?? null;
  const activeRoomId = active?.roomId ?? null;

  // Once you actually go somewhere, the map should follow you again rather than
  // stay parked on the floor you were browsing.
  useEffect(() => setBrowsing(null), [activeNodeId]);

  // Show one storey at a time. Stacked floors overlap in plan-space, so drawing
  // them together would put an upstairs bedroom on top of the kitchen.
  const levels = levelsOf(property.plan);
  const standingOn =
    property.plan.rooms.find((r) => r.id === activeRoomId)?.level ??
    onlyLevel ??
    levels[0] ??
    0;
  const shownLevel = browsing ?? standingOn;
  const roomsHere = property.plan.rooms.filter((r) => r.level === shownLevel);
  const roomIdsHere = new Set(roomsHere.map((r) => r.id));
  const nodesHere = property.nodes.filter((n) => roomIdsHere.has(n.roomId));

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="absolute right-3 bottom-3 rounded-lg border border-ink-600 bg-ink-800/90 px-3 py-2 text-xs text-mist-200 backdrop-blur"
      >
        Show map
      </button>
    );
  }

  return (
    <div className="absolute right-3 bottom-3 w-56 overflow-hidden rounded-lg border border-ink-600 bg-ink-800/90 backdrop-blur">
      <div className="flex items-center justify-between px-2.5 pt-2 pb-1">
        <span className="text-[11px] uppercase tracking-wide text-mist-400">
          {browsing !== null && browsing !== standingOn
            ? levelName(shownLevel)
            : active
              ? property.plan.rooms.find((r) => r.id === active.roomId)?.label
              : levels.length > 1
                ? levelName(shownLevel)
                : "Floor plan"}
        </span>
        <button
          onClick={() => setOpen(false)}
          className="text-xs text-mist-400 hover:text-mist-200"
          aria-label="Hide map"
        >
          ×
        </button>
      </div>

      <svg
        viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
        className="w-full"
        style={{ aspectRatio: `${view.width} / ${view.height}` }}
      >
        {roomsHere.map((room) => {
          const b = boundsOf(room.polygon);
          const isHere = room.id === activeRoomId;
          return (
            <rect
              key={room.id}
              x={b.x0}
              y={b.y0}
              width={b.x1 - b.x0}
              height={b.y1 - b.y0}
              fill={isHere ? "#2a6f9e88" : "#262d37cc"}
              stroke={isHere ? "#4bb3fd" : "#4a5566"}
              strokeWidth={view.width / 300}
            />
          );
        })}

        {nodesHere.map((node) => {
          const isActive = node.id === activeNodeId;
          return (
            <circle
              key={node.id}
              cx={node.position[0]}
              cy={node.position[1]}
              r={view.width / (isActive ? 45 : 70)}
              fill={isActive ? "#4bb3fd" : "#c9d1da"}
              stroke="#0b0d10"
              strokeWidth={view.width / 400}
              style={{ cursor: "pointer" }}
              onClick={() => onSelectNode(node.id)}
            >
              <title>
                {property.plan.rooms.find((r) => r.id === node.roomId)?.label ?? node.id}
              </title>
            </circle>
          );
        })}

        {/* Which way you are facing - a dot alone does not tell you. */}
        {active &&
          (() => {
            const dir = headingToPlanDir(active.heading);
            const reach = view.width / 14;
            return (
              <line
                x1={active.position[0]}
                y1={active.position[1]}
                x2={active.position[0] + dir[0] * reach}
                y2={active.position[1] + dir[1] * reach}
                stroke="#4bb3fd"
                strokeWidth={view.width / 220}
              />
            );
          })()}
      </svg>

      {levels.length > 1 ? (
        <div className="flex items-center gap-1 px-2.5 pt-1.5 pb-2">
          {levels.map((l) => (
            <button
              key={l}
              onClick={() => setBrowsing(l)}
              className={`flex-1 rounded px-1 py-1 text-[10px] transition ${
                l === shownLevel
                  ? "bg-accent text-ink-900"
                  : "border border-ink-500 text-mist-400 hover:bg-ink-700"
              }`}
            >
              {levelName(l)}
              {l === standingOn && <span className="ml-1 opacity-70">•</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="px-2.5 pt-1 pb-2 text-[10px] leading-tight text-mist-400">
          Tap any dot to jump there
        </div>
      )}
    </div>
  );
}
