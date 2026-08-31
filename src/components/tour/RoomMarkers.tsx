"use client";

import { useMemo, useState } from "react";
import * as THREE from "three";

import { runsAtLevel } from "@/lib/model/stairs";
import { walkStartFor } from "@/lib/model/focus";
import { levelBase, planToWorld } from "@/lib/plan/geometry";
import type { Plan, Room, Vec2 } from "@/lib/schema";

/**
 * The places you can stand.
 *
 * These replace the rings that used to mark photographs. The distinction
 * matters: a photo ring was a viewpoint someone had actually shot from, and
 * there were as many of them as there were pictures - two in the kitchen, none
 * in the hall. A room has exactly one obvious place to be dropped into, so the
 * marker is now per room and lands you on your feet rather than at a lens.
 *
 * The stair markers are inherited wholesale from the old node rings, because
 * the problem they solve did not go away: a way up drawn at the top of the
 * flight is metres above your head, and nobody reads a marker in the ceiling as
 * "go this way".
 */

const RING_Y = 0.02;

/**
 * Markers ignore the depth buffer so they stay visible through furniture, which
 * means draw order alone decides whether they are seen. Without an explicit
 * render order they lose to the dollhouse's own transparent surfaces - and
 * silently: the marker is still clickable, so the house appears to have no way
 * in while quietly responding to clicks on empty floor.
 */
const RING_RENDER_ORDER = 20;

function Marker({
  baseY,
  at,
  stairs,
  dimmed,
  onEnter,
}: {
  baseY: number;
  /** Where to draw, which is not always the middle of the room - see stairs. */
  at: Vec2;
  stairs?: "up" | "down";
  dimmed: boolean;
  onEnter?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [x, , z] = planToWorld(at, 0);

  const color = stairs ? "#7ee787" : hovered ? "#bfe6ff" : "#ffffff";
  const opacity = hovered ? 1 : dimmed ? 0.5 : 0.92;

  return (
    <group position={[x, baseY + RING_Y, z]}>
      {onEnter && (
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          renderOrder={RING_RENDER_ORDER + 1}
          onClick={(e) => {
            e.stopPropagation();
            onEnter();
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            setHovered(true);
            document.body.style.cursor = "pointer";
          }}
          onPointerOut={() => {
            setHovered(false);
            document.body.style.cursor = "auto";
          }}
        >
          {/* The disc is the click target; the visible ring sits on top of it. */}
          <circleGeometry args={[0.5, 32]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}

      <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={RING_RENDER_ORDER} raycast={() => null}>
        <ringGeometry args={stairs ? [0.34, 0.52, 40] : [0.3, 0.44, 40]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={opacity}
          side={THREE.DoubleSide}
          depthWrite={false}
          depthTest={false}
        />
      </mesh>

      {/* A chevron pointing the way the stairs go. A ring alone reads as
          "another spot in this room", which is the wrong promise. */}
      {stairs && (
        <mesh
          position={[0, stairs === "up" ? 0.55 : 0.2, 0]}
          rotation={[stairs === "up" ? 0 : Math.PI, 0, 0]}
          renderOrder={RING_RENDER_ORDER}
          raycast={() => null}
        >
          <coneGeometry args={[0.2, 0.34, 4]} />
          <meshBasicMaterial
            color="#7ee787"
            transparent
            opacity={opacity}
            depthWrite={false}
            depthTest={false}
          />
        </mesh>
      )}
    </group>
  );
}

/**
 * Where the way up belongs, on the storey you are standing on.
 *
 * In front of the flight, on the floor, rather than on it. A marker is drawn
 * without depth testing so it is always *visible*, but a click is a ray and the
 * ray hits whichever mesh is nearest - which, since staircases grew real
 * treads, is a tread. Standing it clear of the flight is also simply where a
 * person waits before climbing.
 */
function stairMarkers(plan: Plan, level: number): Array<{ at: Vec2; going: "up" | "down" }> {
  const { up, down } = runsAtLevel(plan, level);
  const out: Array<{ at: Vec2; going: "up" | "down" }> = [];

  for (const [run, going] of [
    [up, "up" as const],
    [down, "down" as const],
  ] as const) {
    if (!run) continue;
    const from = going === "up" ? run.entry.at : run.arrival.at;
    const along = run.entry.into;
    out.push({ at: [from[0] - along[0] * 0.7, from[1] - along[1] * 0.7], going });
  }

  return out;
}

export function RoomMarkers({
  plan,
  mode,
  onlyLevel,
  walkLevel,
  onEnterRoom,
  hidden = false,
}: {
  plan: Plan;
  mode: "dollhouse" | "walk";
  onlyLevel?: number | null;
  /** The storey underfoot, which the stairs change without being asked. */
  walkLevel: number;
  onEnterRoom: (roomId: string) => void;
  /** The house in pieces: walking into one of them means nothing. */
  hidden?: boolean;
}) {
  const rooms = useMemo(() => {
    if (mode === "walk") return [] as Room[];
    if (onlyLevel === null || onlyLevel === undefined) return plan.rooms;
    return plan.rooms.filter((r) => r.level === onlyLevel);
  }, [plan.rooms, mode, onlyLevel]);

  const stairs = useMemo(() => {
    // In the dollhouse the whole stack is on screen and the staircase is
    // visible as a staircase, so it needs no sign. On foot it is the one route
    // you cannot see from where you are standing.
    if (mode !== "walk") return [];
    return stairMarkers(plan, walkLevel).map((s) => ({
      ...s,
      baseY: levelBase(plan, walkLevel),
    }));
  }, [plan, mode, walkLevel]);

  // After the hooks, not before them. `hidden` genuinely changes - it goes true
  // the moment the explode slider leaves zero - so returning early above meant
  // React saw a different number of hooks between two renders of the same
  // component, which is the one rule it cannot recover from.
  if (hidden) return null;

  return (
    <group>
      {rooms.map((room) => {
        const start = walkStartFor(plan, room);
        return (
          <Marker
            key={room.id}
            at={start.position}
            baseY={levelBase(plan, room.level)}
            dimmed={false}
            onEnter={() => onEnterRoom(room.id)}
          />
        );
      })}
      {stairs.map((s) => (
        <Marker key={`s-${s.going}`} at={s.at} baseY={s.baseY} stairs={s.going} dimmed={false} />
      ))}
    </group>
  );
}
