"use client";

import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { type Element } from "@/lib/bom/condition";
import { elementForPiece, type Pick } from "@/lib/bom/pickable";
import { furnishRoom } from "@/lib/model/furniture";
import { BASEBOARD_DEPTH, BASEBOARD_HEIGHT, PALETTE } from "@/lib/model/materials";
import { DEFAULT_SCHEME, type Scheme, floorToneFor, recolour } from "@/lib/model/schemes";
import { explodeLift, explodeOffset, roomShell } from "@/lib/model/room-shell";
import {
  ceilingHolesFor,
  floorHolesFor,
  stairPieces,
  subtractRects,
} from "@/lib/model/stairs";
import {
  TEXTURE_METRES,
  applyWorldUvs,
  canTexture,
  floorFinish,
  floorTexture,
  wallTexture,
} from "@/lib/model/textures";
import { type WallSolid, wallsForLevel } from "@/lib/model/walls";
import { wallPiecesAround, windowsForLevel } from "@/lib/model/windows";
import { boundsOf } from "@/lib/plan/autolayout";
import { area, centroid, levelBase, levelsOf } from "@/lib/plan/geometry";
import type { Plan, Room } from "@/lib/schema";
import { formatArea } from "@/lib/units";

/**
 * The house as a built model rather than a diagram.
 *
 * This replaces a dollhouse of two flat colours and zero-thickness planes. Walls
 * have thickness and are built once each; doorways have headers; exterior walls
 * carry windows; floors are coloured by what the room is; and rooms are
 * furnished. It is meant to be the thing you send someone, with photographs as
 * an optional layer rather than the point.
 *
 * Everything except the walls is merged per colour before it reaches the GPU. A
 * furnished house is several hundred boxes, and several hundred draw calls is
 * the difference between this being smooth on a phone and not. Walls stay
 * separate by facing direction, because they have to be culled independently -
 * see below.
 */

const SLAB = 0.02;

function boxGeometry(
  center: [number, number, number],
  size: [number, number, number],
  rotationY = 0,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
  if (rotationY) geometry.rotateY(rotationY);
  geometry.translate(center[0], center[1], center[2]);
  return geometry;
}

/** Merge a batch of boxes into one geometry, or null when there are none. */
function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  const result = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  return result;
}

function wallGeometry(wall: WallSolid, baseY: number): THREE.BufferGeometry {
  const angle = (wall.angleDeg * Math.PI) / 180;
  return boxGeometry(
    [wall.center[0], baseY + wall.base + wall.height / 2, wall.center[1]],
    [wall.length, wall.height, wall.thickness],
    angle,
  );
}

/**
 * Exterior walls, grouped by which way they face.
 *
 * Grouped rather than merged wholesale so each facing can be hidden
 * independently: from any viewpoint the two elevations between you and the
 * interior have to go, or a dollhouse shows you nothing but its own outside.
 * Four groups is four draw calls, which is affordable; per-wall would be forty.
 */
function ExteriorShell({
  walls,
  baseY,
  opacity,
  walking,
  colour,
}: {
  walls: WallSolid[];
  baseY: number;
  opacity: number;
  walking: boolean;
  colour: string;
}) {
  const groups = useMemo(() => {
    const byFacing = new Map<string, { normal: [number, number]; parts: THREE.BufferGeometry[] }>();
    for (const wall of walls) {
      if (!wall.outward) continue;
      const key = `${wall.outward[0]},${wall.outward[1]}`;
      const entry = byFacing.get(key) ?? { normal: wall.outward as [number, number], parts: [] };
      entry.parts.push(wallGeometry(wall, baseY));
      byFacing.set(key, entry);
    }

    return [...byFacing.values()]
      .map((entry) => {
        const geometry = merged(entry.parts);
        if (!geometry) return null;
        // Centre computed once here rather than per frame: it never moves, and
        // culling runs on every frame for every group.
        geometry.computeBoundingBox();
        const centre = new THREE.Vector3();
        geometry.boundingBox?.getCenter(centre);
        return { normal: entry.normal, geometry, centre };
      })
      .filter(Boolean) as Array<{
        normal: [number, number];
        geometry: THREE.BufferGeometry;
        centre: THREE.Vector3;
      }>;
  }, [walls, baseY]);

  const materials = useRef<Array<THREE.MeshStandardMaterial | null>>([]);

  useFrame(({ camera }) => {
    for (let i = 0; i < groups.length; i++) {
      const material = materials.current[i];
      if (!material) continue;
      const { normal, centre } = groups[i];

      // A wall is in the way when the camera stands on its outward side.
      const toCamera =
        (camera.position.x - centre.x) * normal[0] +
        (camera.position.z - centre.z) * normal[1];

      // Eased across the grazing angle so nothing pops as the view swings, and
      // never quite to zero - a ghost of the elevation keeps the building's
      // outline readable.
      material.opacity = walking
        ? opacity
        : opacity * THREE.MathUtils.clamp(-toCamera / 2.5, 0.05, 1);
    }
  });

  return (
    <>
      {groups.map((group, i) => (
        <mesh key={i} geometry={group.geometry} castShadow receiveShadow>
          <meshStandardMaterial
            ref={(m) => {
              materials.current[i] = m;
            }}
            color={colour}
            roughness={0.95}
            metalness={0}
            transparent
            opacity={opacity}
            depthWrite={false}
          />
        </mesh>
      ))}
    </>
  );
}

function LevelModel({
  plan,
  level,
  opacity,
  furnished,
  walking,
  scheme,
  explode,
  pick,
  onPick,
  onHover,
  onMeasurePoint,
}: {
  plan: Plan;
  level: number;
  opacity: number;
  furnished: boolean;
  walking: boolean;
  scheme: Scheme;
  explode: number;
  pick: Pick | null;
  onPick?: (pick: Pick) => void;
  onHover?: (pick: Pick | null) => void;
  onMeasurePoint?: (point: THREE.Vector3) => void;
}) {
  const baseY = levelBase(plan, level);

  // Geometry is rebuilt only when the house comes apart or goes back together,
  // never as the slider moves - the movement itself is a transform, and
  // remerging a few hundred boxes sixty times a second is not.
  const exploded = explode > 0;

  const built = useMemo(() => {
    const rooms = plan.rooms.filter((r) => r.level === level);
    const walls = wallsForLevel(plan, level);
    const windows = windowsForLevel(plan, level);

    // Exterior walls carrying a window are rebuilt as the pieces around it,
    // which is cheaper and far simpler than subtracting a solid.
    const windowed = new Set<WallSolid>();
    const interiorParts: THREE.BufferGeometry[] = [];
    const exterior: WallSolid[] = [];

    for (const wall of walls) {
      if (!wall.exterior) {
        interiorParts.push(wallGeometry(wall, baseY));
        continue;
      }
      const window = windows.find(
        (w) =>
          !windowed.has(wall) &&
          Math.abs(w.center[0] - wall.center[0]) < 0.01 &&
          Math.abs(w.center[1] - wall.center[1]) < 0.01 &&
          !wall.header,
      );
      if (window) {
        windowed.add(wall);
        exterior.push(...wallPiecesAround(wall, window));
      } else {
        exterior.push(wall);
      }
    }

    /**
     * Surfaces are merged by room and element, not by colour.
     *
     * Merging everything of one colour into a single mesh was cheaper and made
     * the model anonymous: there was no way to ask what you had clicked. Keying
     * on room and element keeps identity while still collapsing a house down to
     * a few dozen draw calls, which is the trade worth making - a model you can
     * interrogate is the point, and sixty meshes is nothing.
     */
    const surfaces = new Map<
      string,
      { roomId: string; element: Element; colour: string; parts: THREE.BufferGeometry[] }
    >();

    const addSurface = (
      roomId: string,
      element: Element,
      colour: string,
      geometry: THREE.BufferGeometry,
    ) => {
      const key = `${roomId}|${element}|${colour}`;
      const entry = surfaces.get(key) ?? { roomId, element, colour, parts: [] };
      entry.parts.push(geometry);
      surfaces.set(key, entry);
    };

    for (const room of rooms) {
      const b = boundsOf(room.polygon);
      const w = b.x1 - b.x0;
      const d = b.y1 - b.y0;

      // The floor, with the stairwell cut out of it where a staircase arrives.
      // `subtractRects` returns the room untouched when there is no hole, so
      // every other room in the house is byte-identical to before.
      const roomRect = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
      const floorPieces = subtractRects(roomRect, floorHolesFor(plan, room));
      for (const piece of floorPieces) {
        const pw = piece.x1 - piece.x0;
        const pd = piece.y1 - piece.y0;
        addSurface(
          room.id,
          "floor",
          floorToneFor(room.label, scheme),
          boxGeometry([piece.x0 + pw / 2, baseY - SLAB / 2, piece.y0 + pd / 2], [pw, SLAB, pd]),
        );
      }

      // A ceiling, but only when someone is under it - and opened where the
      // staircase leaves, or you climb the treads into the underside of it.
      if (walking) {
        for (const piece of subtractRects(roomRect, ceilingHolesFor(plan, room))) {
          const pw = piece.x1 - piece.x0;
          const pd = piece.y1 - piece.y0;
          addSurface(
            room.id,
            "ceiling",
            scheme.ceiling,
            boxGeometry(
              [piece.x0 + pw / 2, baseY + room.ceilingHeight + SLAB / 2, piece.y0 + pd / 2],
              [pw, SLAB, pd],
            ),
          );
        }
      }

      // Pulled apart, a room carries its own four walls. Assembled it shares
      // them with its neighbours, which is what stops the dollhouse having
      // doubled partitions - so this is only built when it is needed.
      if (exploded) {
        for (const box of roomShell(plan, room)) {
          addSurface(
            room.id,
            "walls",
            scheme.wall,
            boxGeometry(
              [box.center[0], baseY + box.center[1], box.center[2]],
              box.size,
            ),
          );
        }
      }

      // The staircase itself. Structure rather than staging, so it is drawn
      // whether or not the house is furnished.
      for (const piece of stairPieces(plan, room, level)) {
        for (const box of piece.boxes) {
          addSurface(
            room.id,
            "floor",
            recolour(box.colour, scheme),
            boxGeometry(
              [b.x0 + box.center[0], baseY + box.center[1], b.y0 + box.center[2]],
              box.size,
            ),
          );
        }
      }

      // A baseboard around the room. Small, and it is most of what stops a
      // wall meeting a floor looking like two flat planes intersecting.
      const h = BASEBOARD_HEIGHT;
      const t = BASEBOARD_DEPTH;
      const y = baseY + h / 2;
      // Nothing to run skirting along when the floor is a stairwell.
      const skirting = floorPieces.length === 0 ? [] : [
        boxGeometry([b.x0 + w / 2, y, b.y0 + t / 2], [w, h, t]),
        boxGeometry([b.x0 + w / 2, y, b.y1 - t / 2], [w, h, t]),
        boxGeometry([b.x0 + t / 2, y, b.y0 + d / 2], [t, h, d]),
        boxGeometry([b.x1 - t / 2, y, b.y0 + d / 2], [t, h, d]),
      ];
      for (const part of skirting) {
        addSurface(room.id, "trim", scheme.trim, part);
      }

      if (furnished) {
        for (const piece of furnishRoom(plan, room)) {
          // Staging - a bed, a sofa - has no line item behind it, so it picks
          // its room rather than inventing an element it does not represent.
          const element = elementForPiece(piece.kind);
          for (const box of piece.boxes) {
            addSurface(
              room.id,
              element ?? "floor",
              recolour(box.colour, scheme),
              boxGeometry(
                [b.x0 + box.center[0], baseY + box.center[1], b.y0 + box.center[2]],
                box.size,
              ),
            );
          }
        }
      }
    }

    const frameParts: THREE.BufferGeometry[] = [];
    const glassParts: THREE.BufferGeometry[] = [];
    for (const window of windows) {
      const angle = (window.angleDeg * Math.PI) / 180;
      const height = window.head - window.sill;
      const y = baseY + (window.sill + window.head) / 2;
      frameParts.push(
        boxGeometry([window.center[0], y, window.center[1]],
          [window.width, height, window.thickness], angle),
      );
      glassParts.push(
        boxGeometry([window.center[0], y, window.center[1]],
          [window.width - 0.09, height - 0.09, window.thickness + 0.01], angle),
      );
    }

    return {
      rooms,
      exterior,
      interior: merged(interiorParts),
      surfaces: [...surfaces.values()]
        .map((entry) => {
          const geometry = merged(entry.parts);
          // Floors are read off the plan and walls off their own face, so the
          // two need different tile sizes to end up at the same apparent scale.
          if (geometry) {
            applyWorldUvs(
              geometry,
              entry.element === "floor" ? TEXTURE_METRES.floor : TEXTURE_METRES.wall,
            );
          }
          const room = rooms.find((r) => r.id === entry.roomId);
          return {
            ...entry,
            geometry,
            texture: canTexture()
              ? entry.element === "floor"
                ? floorTexture(floorFinish(room?.label ?? ""), entry.colour)
                : entry.element === "walls" || entry.element === "ceiling"
                  ? wallTexture(entry.colour)
                  : null
              : null,
          };
        })
        .filter((entry) => entry.geometry) as Array<{
          roomId: string;
          element: Element;
          colour: string;
          geometry: THREE.BufferGeometry;
          texture: THREE.Texture | null;
        }>,
      frames: merged(frameParts),
      glass: merged(glassParts),
    };
  }, [plan, level, baseY, furnished, walking, scheme, exploded]);

  // Every surface of one room moves together, so a room comes apart from the
  // house as one part rather than as a floor and some furniture that happen to
  // travel the same way.
  const offsetFor = (roomId: string): [number, number, number] => {
    if (!exploded) return [0, 0, 0];
    const room = built.rooms.find((r) => r.id === roomId);
    if (!room) return [0, 0, 0];
    const [dx, dy] = explodeOffset(plan, room, explode);
    return [dx, explodeLift(level, explode), dy];
  };

  return (
    <group>
      {built.surfaces.map((surface) => {
        const selected =
          pick?.roomId === surface.roomId &&
          (pick.element === null || pick.element === surface.element);

        return (
          <mesh
            key={`${surface.roomId}-${surface.element}-${surface.colour}`}
            position={offsetFor(surface.roomId)}
            geometry={surface.geometry}
            castShadow
            receiveShadow
            onPointerOver={(e) => {
              if (!onPick) return;
              e.stopPropagation();
              onHover?.({ roomId: surface.roomId, element: surface.element });
              document.body.style.cursor = "pointer";
            }}
            onPointerOut={() => {
              if (!onPick) return;
              onHover?.(null);
              document.body.style.cursor = "auto";
            }}
            onClick={(e) => {
              // Measuring wants the point on the surface, not which surface it
              // was. Taking precedence over picking keeps the two from fighting
              // over the same click.
              if (onMeasurePoint) {
                e.stopPropagation();
                onMeasurePoint(e.point.clone());
                return;
              }
              if (!onPick) return;
              e.stopPropagation();
              onPick({ roomId: surface.roomId, element: surface.element });
            }}
          >
            <meshStandardMaterial
              // The texture already carries the colour, so tinting it again
              // would darken every surface by its own shade.
              color={surface.texture ? "#ffffff" : surface.colour}
              map={surface.texture ?? undefined}
              roughness={surface.element === "floor" ? 0.78 : 0.9}
              metalness={0}
              transparent
              opacity={opacity}
              // Lifting what is selected rather than tinting it: a colour shift
              // would fight the palette, and on a pale model a slight glow reads
              // as "this one" without looking like a different material.
              emissive={selected ? "#4bb3fd" : "#000000"}
              emissiveIntensity={selected ? 0.32 : 0}
            />
          </mesh>
        );
      })}

      {!exploded && built.interior && (
        <mesh geometry={built.interior} castShadow receiveShadow>
          <meshStandardMaterial
            color={scheme.wall}
            roughness={0.95}
            metalness={0}
            transparent
            opacity={opacity}
          />
        </mesh>
      )}

      {/* The shared shell is the assembled house. Pulled apart, each room has
          brought its own walls and this would be a second set floating where
          the building used to be. */}
      {!exploded && (
        <ExteriorShell
          walls={built.exterior}
          baseY={baseY}
          opacity={opacity}
          walking={walking}
          colour={scheme.wallExterior}
        />
      )}

      {!exploded && built.frames && (
        <mesh geometry={built.frames}>
          <meshStandardMaterial color={PALETTE.frame} roughness={0.6} transparent opacity={opacity} />
        </mesh>
      )}
      {!exploded && built.glass && (
        <mesh geometry={built.glass}>
          {/*
            Nearly opaque, not see-through. Real glass would show whatever is
            behind it, and behind an upstairs window there is nothing but the
            page - so a transparent pane rendered as a dark navy hole rather
            than a window. An architectural model wants glass that reads as
            glass from outside, which means a pale panel.
          */}
          <meshStandardMaterial
            color={PALETTE.glass}
            roughness={0.08}
            metalness={0.15}
            transparent
            opacity={opacity * 0.92}
          />
        </mesh>
      )}
    </group>
  );
}

export function Model({
  plan,
  opacity,
  showLabels,
  displayUnits,
  onlyLevel,
  furnished = true,
  pick = null,
  onPick,
  onHover,
  onMeasurePoint,
  walking = false,
  scheme = DEFAULT_SCHEME,
  explode = 0,
}: {
  plan: Plan;
  opacity: number;
  showLabels: boolean;
  displayUnits: "ft" | "m";
  onlyLevel?: number | null;
  furnished?: boolean;
  /**
   * True when the camera is inside the house on foot.
   *
   * Two things have to change. A dollhouse has no ceilings - they would hide
   * everything it exists to show - and standing in a room without one you look
   * up into the page background, which is the single most obvious way to tell
   * a model from a building. And the exterior shell must stop fading, since
   * from inside there is nothing in the way to fade.
   */
  walking?: boolean;
  /** What is currently selected, so it can be lit. */
  pick?: Pick | null;
  /** Absent means the model is not interrogable - no cursor, no picking. */
  onPick?: (pick: Pick) => void;
  onHover?: (pick: Pick | null) => void;
  /** Set while the tape measure is out; receives the exact point clicked. */
  onMeasurePoint?: (point: THREE.Vector3) => void;
  /** The interior direction. Changes the whole house together. */
  scheme?: Scheme;
  /**
   * How far the house is pulled apart, 0 to 1.
   *
   * At zero nothing moves and the model is exactly the assembled house. Above
   * zero every room becomes a separate part with its own walls, which is what
   * an exploded assembly drawing shows and what lets a room be looked at and
   * costed on its own.
   */
  explode?: number;
}) {
  const levels = useMemo(() => {
    const all = levelsOf(plan);
    return onlyLevel === null || onlyLevel === undefined ? all : all.filter((l) => l === onlyLevel);
  }, [plan, onlyLevel]);

  const labelled = useMemo(
    () =>
      plan.rooms.filter((r) => levels.includes(r.level)),
    [plan.rooms, levels],
  );

  if (opacity <= 0.001) return null;

  return (
    <group>
      {levels.map((level) => (
        <LevelModel
          key={level}
          plan={plan}
          level={level}
          opacity={opacity}
          furnished={furnished}
          walking={walking}
          scheme={scheme}
          explode={explode}
          pick={pick}
          onPick={onPick}
          onHover={onHover}
          onMeasurePoint={onMeasurePoint}
        />
      ))}

      {showLabels &&
        labelled.map((room: Room) => {
          const c = centroid(room.polygon);
          // A label that stayed behind while its room left would be labelling
          // the hole where the room used to be.
          const offset = explodeOffset(plan, room, explode);
          return (
            <Html
              key={room.id}
              position={[
                c[0] + offset[0],
                levelBase(plan, room.level) + 0.06 + explodeLift(room.level, explode),
                c[1] + offset[1],
              ]}
              center
              distanceFactor={9}
              zIndexRange={[10, 0]}
            >
              <div className="pointer-events-none select-none text-center">
                <div className="text-[13px] font-medium tracking-wide text-ink-900">
                  {room.label}
                </div>
                <div className="text-[11px] text-ink-700">
                  {formatArea(area(room.polygon), displayUnits)}
                </div>
              </div>
            </Html>
          );
        })}
    </group>
  );
}
