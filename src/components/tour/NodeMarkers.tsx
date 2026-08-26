"use client";

import { useMemo, useState } from "react";
import * as THREE from "three";

import { headingToPlanDir, levelBase, nodeBaseY, planToWorld } from "@/lib/plan/geometry";
import type { Plan, TourNode, Vec2 } from "@/lib/schema";

/**
 * The rings you step on.
 *
 * While inside a room only the current node's neighbours are shown, so the
 * available moves are exactly the edges of the walk graph - you cannot click
 * your way through a wall, because no ring is ever drawn on the other side.
 */

const RING_Y = 0.02;

/**
 * Rings ignore the depth buffer so they stay visible through furniture, which
 * means draw order alone decides whether they are seen. Without an explicit
 * render order they lose to the dollhouse's own transparent surfaces - and
 * silently: the ring is still clickable, so the tour appears to have no way
 * onward while quietly responding to clicks on empty floor.
 */
const RING_RENDER_ORDER = 20;

function Ring({
  node,
  active,
  dimmed,
  baseY,
  at,
  stairs,
  onSelect,
}: {
  node: TourNode;
  active: boolean;
  dimmed: boolean;
  baseY: number;
  /** Where to draw, which is not always where the node is - see stairs. */
  at: Vec2;
  stairs?: "up" | "down";
  onSelect: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [x, , z] = planToWorld(at, 0);

  const color = stairs ? "#7ee787" : active ? "#4bb3fd" : hovered ? "#bfe6ff" : "#ffffff";
  const opacity = active ? 1 : hovered ? 1 : dimmed ? 0.5 : 0.92;

  return (
    <group position={[x, baseY + RING_Y, z]}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={RING_RENDER_ORDER + 1}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(node.id);
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

      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={RING_RENDER_ORDER}
        raycast={() => null}
      >
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

/** A wedge showing which way a photo faces. Only useful in the dollhouse. */
function HeadingWedge({ node, baseY }: { node: TourNode; baseY: number }) {
  const [x, , z] = planToWorld(node.position, 0);
  const dir = headingToPlanDir(node.heading);

  const geometry = useMemo(() => {
    const half = (node.fovDeg * Math.PI) / 180 / 2;
    const reach = 1.15;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(Math.sin(-half) * reach, Math.cos(-half) * reach);
    shape.lineTo(Math.sin(half) * reach, Math.cos(half) * reach);
    shape.closePath();
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(Math.PI / 2);
    return g;
  }, [node.fovDeg]);

  return (
    <mesh
      geometry={geometry}
      position={[x, baseY + RING_Y - 0.005, z]}
      rotation={[0, Math.atan2(dir[0], dir[1]), 0]}
      renderOrder={RING_RENDER_ORDER - 5}
      raycast={() => null}
    >
      <meshBasicMaterial
        color="#4bb3fd"
        transparent
        opacity={0.3}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}

export function NodeMarkers({
  plan,
  nodes,
  activeNodeId,
  mode,
  onlyLevel,
  onSelect,
  hidden = false,
}: {
  plan: Plan;
  nodes: TourNode[];
  activeNodeId: string | null;
  mode: "dollhouse" | "node";
  onlyLevel?: number | null;
  onSelect: (id: string) => void;
  /** Walking on foot: the rings are a way of moving you no longer need. */
  hidden?: boolean;
}) {
  if (hidden) return null;
  const active = nodes.find((n) => n.id === activeNodeId) ?? null;

  const onShownFloor = useMemo(() => {
    if (onlyLevel === null || onlyLevel === undefined) return nodes;
    const ids = new Set(plan.rooms.filter((r) => r.level === onlyLevel).map((r) => r.id));
    return nodes.filter((n) => ids.has(n.roomId));
  }, [nodes, plan.rooms, onlyLevel]);

  /**
   * Where a neighbour's ring belongs.
   *
   * Normally that is simply where the node is. But a viewpoint on another
   * storey is metres above or below your head, and a ring floating in the
   * ceiling is not something anyone reads as "go this way". So a cross-storey
   * neighbour is drawn at the stairs instead, on the floor you are standing on -
   * which is where you would actually walk to get there.
   */
  const placementFor = (neighbor: TourNode): { at: Vec2; baseY: number; stairs?: "up" | "down" } => {
    const here = plan.rooms.find((r) => r.id === active?.roomId);
    const there = plan.rooms.find((r) => r.id === neighbor.roomId);
    if (!here || !there || here.level === there.level) {
      return { at: neighbor.position, baseY: nodeBaseY(plan, neighbor) };
    }

    const stair = plan.openings.find((o) => {
      if (o.kind !== "stairs") return false;
      const levels = o.between.map(
        (id) => plan.rooms.find((r) => r.id === id)?.level,
      );
      return levels.includes(here.level) && levels.includes(there.level);
    });

    return {
      at: stair ? stair.at : neighbor.position,
      baseY: levelBase(plan, here.level),
      stairs: there.level > here.level ? "up" : "down",
    };
  };

  const visible = useMemo(() => {
    if (mode === "dollhouse") return onShownFloor;
    if (!active) return [];
    // Inside a room, neighbours are shown regardless of storey - the ring at the
    // top of the stairs is exactly the one you need to see.
    const allowed = new Set(active.neighbors);
    return nodes.filter((n) => allowed.has(n.id));
  }, [nodes, onShownFloor, mode, active]);

  return (
    <group>
      {visible.map((node) => {
        const placement =
          mode === "node" && active
            ? placementFor(node)
            : { at: node.position, baseY: nodeBaseY(plan, node) };
        return (
          <Ring
            key={node.id}
            node={node}
            active={node.id === activeNodeId}
            dimmed={mode === "dollhouse" && activeNodeId !== null}
            baseY={placement.baseY}
            at={placement.at}
            stairs={placement.stairs}
            onSelect={onSelect}
          />
        );
      })}
      {mode === "dollhouse" &&
        onShownFloor.map((node) => (
          <HeadingWedge key={`w-${node.id}`} node={node} baseY={nodeBaseY(plan, node)} />
        ))}
    </group>
  );
}
