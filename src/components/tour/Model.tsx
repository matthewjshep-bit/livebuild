"use client";

import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { boxGeometry, merged, slabGeometry, solid } from "@/lib/model/solids";
import { runGeometry } from "@/lib/model/profiles";
import { joineryFor } from "@/lib/model/joinery";
import { ceilingParts } from "@/lib/model/ceiling";

import { type Element } from "@/lib/bom/condition";
import { elementForPiece, type Pick } from "@/lib/bom/pickable";
import { piecesFor } from "@/lib/model/staging";
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
  floorSurface,
  type Surface,
  wallSurface,
} from "@/lib/model/textures";
import { type WallSolid, roomIsRectilinear, wallsForLevel } from "@/lib/model/walls";
import { wallPiecesAround, windowsForLevel } from "@/lib/model/windows";
import { boundsOf } from "@/lib/plan/autolayout";
import {
  area,
  centroid,
  levelBase,
  levelsOf,
  fromFrame,
  signedArea,
  wallSegmentsForRoom,
} from "@/lib/plan/geometry";
import { decompose } from "@/lib/plan/footprint";
import type { HouseSpec } from "@/lib/spec/schema";
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
/**
 * How much of a room is left when it is not the one being looked at.
 *
 * Faded rather than hidden. A room lifted out of an empty void tells you
 * nothing about where it sits in the house, and the whole reason to look at one
 * room in a model rather than in a spreadsheet is that the model knows.
 *
 * Everything that is not the focused room goes to this together - including the
 * walls, which unexploded are one merged mesh for the whole storey and cannot
 * be dimmed a room at a time. The focused room therefore reads as a lit floor
 * and its furniture inside a ghosted envelope, which is what an architectural
 * drawing does to say "this one".
 */
const UNFOCUSED_OPACITY = 0.16;

function ExteriorShell({
  walls,
  baseY,
  opacity = 1,
  walking,
  colour,
}: {
  walls: WallSolid[];
  baseY: number;
  /** Below 1 only while the house is being ghosted for focus. */
  opacity?: number;
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
  spec,
  level,
  opacity,
  furnished,
  walking,
  scheme,
  explode,
  focusRoomId,
  pick,
  onPick,
  onFocusRoom,
  onEnterRoom,
  onHover,
  onMeasurePoint,
}: {
  plan: Plan;
  /** What each room is made of, when anything has read or inferred it. */
  spec: HouseSpec | null | undefined;
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
  onFocusRoom?: (roomId: string) => void;
  onEnterRoom?: (roomId: string) => void;
  focusRoomId?: string | null;
}) {
  const baseY = levelBase(plan, level);

  /**
   * What everything that is not the focused room is drawn at.
   *
   * Multiplied into the opacity already in play rather than replacing it - that
   * one is carrying the dollhouse fade and the backdrop behind a photograph,
   * and overwriting it would undo both.
   */
  const dimmed = focusRoomId ? opacity * UNFOCUSED_OPACITY : opacity;
  const opacityFor = (roomId: string) => (roomId === focusRoomId ? opacity : dimmed);

  /**
   * Whether anything on this storey is see-through at all.
   *
   * `transparent` used to be set on every surface unconditionally, so the model
   * could sit behind a photograph fading up over it. Nothing fades up over it
   * now, and the flag is not free: a transparent material is sorted rather than
   * depth-tested, writes no depth by default, and takes the whole house out of
   * every depth-based effect. Solid unless something is actually being ghosted.
   */
  const ghosted = opacity < 0.999 || focusRoomId !== null;

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
      {
        roomId: string;
        element: Element;
        colour: string;
        staging: boolean;
        parts: THREE.BufferGeometry[];
      }
    >();

    /**
     * `staging` separates the building from the things standing in it.
     *
     * A bed and a sofa have no line item behind them, so they are filed under
     * the room's floor - which is right for pricing and picking, and was
     * quietly wrong for texturing: the floor finish is chosen by element, so a
     * sofa in a bedroom came out surfaced in carpet, tinted to the sofa's own
     * colour. Flat colour hid it. Once the finishes carried real relief it
     * stopped being hideable, because the sofa acquired a carpet's pile.
     *
     * So the element still says where the cost goes, and this says whether the
     * thing is architecture.
     */
    const addSurface = (
      roomId: string,
      element: Element,
      colour: string,
      geometry: THREE.BufferGeometry,
      staging = false,
    ) => {
      const key = `${roomId}|${element}|${colour}|${staging ? "s" : "a"}`;
      const entry = surfaces.get(key) ?? { roomId, element, colour, staging, parts: [] };
      entry.parts.push(geometry);
      surfaces.set(key, entry);
    };

    for (const room of rooms) {
      const b = boundsOf(room.polygon);
      const w = b.x1 - b.x0;
      const d = b.y1 - b.y0;

      // The floor, decomposed from the room's own outline and then cut where
      // a staircase arrives.
      //
      // `decompose` turns a rectilinear polygon into maximal rectangles, so a
      // plain rectangular room yields exactly one and comes out identical to
      // before, while an L-shaped room yields two and stops spilling its floor
      // across the notch. `subtractRects` then returns each piece untouched
      // when there is no hole in it.
      // What this room is made of, when anything has worked it out.
      //
      // The scheme stays underneath as the fallback, and that is deliberate
      // rather than transitional: a scheme is a direction somebody chose for a
      // house nobody has described, and it should still be there for one. The
      // spec is finer-grained than a scheme by design, so it is consulted
      // first and per field - a room whose floor was read but whose walls were
      // not takes its floor from the photograph and its walls from the
      // direction.
      const roomSpec = spec?.rooms[room.id];
      const floorTone = roomSpec?.floor?.colour ?? floorToneFor(room.label, scheme);
      const wallTone = roomSpec?.walls?.colour ?? scheme.wall;
      const ceilingTone = roomSpec?.ceiling?.colour ?? scheme.ceiling;
      const trimTone = roomSpec?.trim?.colour ?? scheme.trim;

      /**
       * The floor, built two ways depending on the room's shape.
       *
       * A rectilinear room goes through `decompose` exactly as it always has -
       * maximal rectangles, then cut where a stairwell drops through. That path
       * is what every existing test exercises and it produces boxes, which
       * merge and cost less than triangles.
       *
       * Anything else is triangulated from its own outline, because `decompose`
       * uses the polygon's own x and y values as gridlines: handed a room at
       * seven degrees it returns a coarse staircase that does not cover the
       * shape, with no error. A wrong floor is not a thing anybody notices from
       * outside; they notice it by walking through it.
       *
       * The stair hole is the one thing the triangulated path gives up for now,
       * so a stairwell in an angled room is not cut out of it yet.
       */
      const holes = floorHolesFor(plan, room);
      if (roomIsRectilinear(room.polygon)) {
        const floorPieces = decompose(room.polygon).flatMap((rect) =>
          subtractRects(rect, holes),
        );
        for (const piece of floorPieces) {
          const pw = piece.x1 - piece.x0;
          const pd = piece.y1 - piece.y0;
          addSurface(
            room.id,
            "floor",
            floorTone,
            boxGeometry([piece.x0 + pw / 2, baseY - SLAB / 2, piece.y0 + pd / 2], [pw, SLAB, pd]),
          );
        }
      } else {
        const slab = slabGeometry(room.polygon, baseY, SLAB);
        if (slab) addSurface(room.id, "floor", floorTone, slab);
      }

      /**
       * The ceiling, and whatever hangs from it.
       *
       * The surface itself is drawn only when somebody is under it - a
       * dollhouse with lids on is a set of closed boxes. Beams are not: they
       * are structure rather than surface, they are most of what makes a
       * ceiling worth remarking on, and the dollhouse is where a house is
       * judged. So the two are split, and beams are drawn either way.
       */
      const ceilingCuts = ceilingHolesFor(plan, room);
      for (const part of ceilingParts(room, roomSpec?.ceiling, ceilingCuts, room.ceilingHeight)) {
        if (part.kind !== "beam" && !walking) continue;
        addSurface(
          room.id,
          "ceiling",
          part.kind === "beam" ? roomSpec?.ceiling?.beams?.colour ?? scheme.trim : ceilingTone,
          boxGeometry([part.center[0], baseY + part.center[1], part.center[2]], part.size),
        );
      }

      // Pulled apart, a room carries its own four walls. Assembled it shares
      // them with its neighbours, which is what stops the dollhouse having
      // doubled partitions - so this is only built when it is needed.
      if (exploded) {
        for (const box of roomShell(plan, room)) {
          addSurface(
            room.id,
            "walls",
            wallTone,
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
            solid(
              [b.x0 + box.center[0], baseY + box.center[1], b.y0 + box.center[2]],
              box.size,
            ),
            true,
          );
        }
      }

      // A baseboard around the room. Small, and it is most of what stops a
      // wall meeting a floor looking like two flat planes intersecting.
      //
      // Run off `wallSegmentsForRoom`, which walks the real outline and takes
      // the doorways out of it. The four bounding-box runs this replaces were
      // wrong twice over: they cut straight across an L-shaped room's notch,
      // and they carried on through every doorway - while `takeoff.baseboardLf`
      // has always been door-subtracted, off this very function. The model and
      // the price now measure the same skirting.
      if (area(room.polygon) > 1e-6) {
        const h = roomSpec?.trim?.baseboardM ?? BASEBOARD_HEIGHT;
        const profile = roomSpec?.trim?.profile ?? "square";

        /**
         * Which way is into the room, across a run of its boundary.
         *
         * Read off the winding rather than guessed at. `wallSegmentsForRoom`
         * walks the polygon in order, so for a positively wound room the
         * inward normal of a→b is (-dy, dx) - exact, at any angle, and correct
         * for a concave room where the old test was not. That test asked
         * whether the bounding box's centre was above or below the run, which
         * for an L-shaped room's notch points the skirting into the wall.
         */
        const wound = signedArea(room.polygon) >= 0 ? 1 : -1;
        const inwardOf = (ax: number, ay: number, bx: number, by: number): [number, number] => {
          const dx = bx - ax;
          const dy = by - ay;
          const length = Math.hypot(dx, dy) || 1;
          return [(-dy / length) * wound, (dx / length) * wound];
        };

        for (const segment of wallSegmentsForRoom(room, plan.openings)) {
          const [ax, ay] = segment.a;
          const [bx, by] = segment.b;
          const runX = Math.abs(bx - ax);
          const runY = Math.abs(by - ay);
          if (runX < 1e-4 && runY < 1e-4) continue;

          // Which way is into the room, across this run. The segment lies on
          // the boundary, so the answer is the perpendicular that points at the
          // middle - and it has to be right, or the skirting is built inside
          // the plaster where nobody will ever see it.
          const inward = inwardOf(ax, ay, bx, by);

          const run = runGeometry(profile, segment, {
            height: h,
            depth: BASEBOARD_DEPTH,
            baseY,
            inward,
            // Closes the corner. A real skirting is mitred; at fifteen
            // millimetres, running each length past its end by its own depth is
            // indistinguishable and needs no mitre solver.
            extend: BASEBOARD_DEPTH,
          });
          if (run) addSurface(room.id, "trim", trimTone, run);
        }

        /**
         * Crown, where the room says it has any.
         *
         * The same run, upside down at the top of the wall. Turning the profile
         * over is what makes one generator serve both: a crown moulding is a
         * skirting that grew from the ceiling instead of the floor, and the
         * only real difference is which way the shadow falls.
         */
        const crownM = roomSpec?.trim?.crown ? (roomSpec.trim.crownM ?? 0.1) : 0;
        if (crownM > 0) {
          for (const segment of wallSegmentsForRoom(room, plan.openings)) {
            const [ax, ay] = segment.a;
            const [bx, by] = segment.b;
            const runX = Math.abs(bx - ax);
            const runY = Math.abs(by - ay);
            if (runX < 1e-4 && runY < 1e-4) continue;
            const inward = inwardOf(ax, ay, bx, by);
            const run = runGeometry(profile, segment, {
              height: crownM,
              depth: crownM * 0.8,
              baseY: baseY + room.ceilingHeight - crownM,
              inward,
              extend: crownM * 0.8,
            });
            if (run) addSurface(room.id, "trim", trimTone, run);
          }
        }
      }

      /**
       * Fitted joinery: cabinetry, islands, vanities, built-in wardrobes.
       *
       * Ungated by `furnished`, and that is the distinction the whole toggle
       * rests on. A run of kitchen units is not staging - it is what is being
       * bought, it is what the scope of work prices, and it is still there when
       * the seller's furniture has gone. Turning furniture off should empty a
       * house, not strip it.
       */
      for (const piece of joineryFor(room, roomSpec)) {
        const element = elementForPiece(piece.kind);
        for (const boxPart of piece.boxes) {
          addSurface(
            room.id,
            element ?? "cabinets",
            boxPart.colour,
            solid(
              [b.x0 + boxPart.center[0], baseY + boxPart.center[1], b.y0 + boxPart.center[2]],
              boxPart.size,
            ),
          );
        }
      }

      {
        for (const piece of piecesFor(plan, room, furnished, roomSpec)) {
          // Staging - a bed, a sofa - has no line item behind it, so it picks
          // its room rather than inventing an element it does not represent.
          const element = elementForPiece(piece.kind);
          /**
           * Placed in the room's own frame when it has one.
           *
           * A piece is built in room-local metres, and for a room square to the
           * world that is the bounding box's corner with world axes - which is
           * what the fallback below still does. For a room at an angle the
           * frame turns the position and the box together, so a run of units
           * sits along the wall it was put on rather than across it.
           */
          const frame = piece.frame;
          const turn = frame ? (-frame.rotationDeg * Math.PI) / 180 : 0;
          for (const box of piece.boxes) {
            const at: [number, number] = frame
              ? fromFrame(frame, [box.center[0], box.center[2]])
              : [b.x0 + box.center[0], b.y0 + box.center[2]];
            addSurface(
              room.id,
              element ?? "floor",
              recolour(box.colour, scheme),
              solid([at[0], baseY + box.center[1], at[1]], box.size, turn),
              true,
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
            surface: canTexture() && !entry.staging
              ? entry.element === "floor"
                ? floorSurface(
                    // The material the spec named, or the one a room of this
                    // kind usually has. `floorFinish` reads the label, which is
                    // the guess the house made before anyone looked at it.
                    (spec?.rooms[entry.roomId]?.floor?.material as
                      | ReturnType<typeof floorFinish>
                      | undefined) ?? floorFinish(room?.label ?? ""),
                    entry.colour,
                  )
                : entry.element === "walls" || entry.element === "ceiling"
                  ? wallSurface(entry.colour)
                  : null
              : null,
          };
        })
        .filter((entry) => entry.geometry) as Array<{
          roomId: string;
          element: Element;
          colour: string;
          staging: boolean;
          geometry: THREE.BufferGeometry;
          surface: Surface | null;
        }>,
      frames: merged(frameParts),
      glass: merged(glassParts),
    };
  }, [plan, spec, level, baseY, furnished, walking, scheme, exploded]);

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
        /**
         * A picked *fitting* glows. A picked room does not.
         *
         * `pick` carries two quite different things. Clicking a worktop picks
         * that worktop, and lifting it is exactly right - it is how you see
         * which of a dozen surfaces the scope rail is now talking about.
         * Walking into a room also sets a pick, of the whole room with no
         * element, so the rail can follow you: and that used to light every
         * surface in the room you were standing in.
         *
         * The effect was subtle on a wall and glaring on a ceiling. A ceiling
         * is the dimmest surface in any room - nothing shines up at it - so an
         * added constant is most of what you see there, and every interior came
         * out with a distinctly blue ceiling. It survived turning off the
         * environment, every light in the scene, the tone mapping and the
         * normal map, because it was never lighting at all; it was `emissive`,
         * which is added after all of them.
         *
         * There is nothing to distinguish anyway. Being in a room is not a
         * selection, and the focus ghosting already says which room is being
         * looked at far more clearly than a tint could.
         */
        const selected = pick?.roomId === surface.roomId && pick.element === surface.element;

        return (
          <mesh
            userData={{ element: surface.element }}
            // Must carry `staging`, because the merge key does.
            //
            // Two entries differing only in whether they are architecture or
            // staging are separate meshes with separate materials, and without
            // it they collide as React children. It is not hypothetical: in
            // "Warm minimal" `floors.carpet` and `furniture.soft` are both
            // #c3b6a3, and a bed's pillow is filed under its room's floor - so
            // a carpeted bedroom produced two children with the same key.
            key={`${surface.roomId}-${surface.element}-${surface.colour}-${surface.staging ? "s" : "a"}`}
            position={offsetFor(surface.roomId)}
            geometry={surface.geometry}
            castShadow
            receiveShadow
            onPointerOver={(e) => {
              if (!onPick && !onFocusRoom) return;
              e.stopPropagation();
              onHover?.({ roomId: surface.roomId, element: surface.element });
              document.body.style.cursor = "pointer";
            }}
            onPointerOut={() => {
              if (!onPick && !onFocusRoom) return;
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
              if (!onPick && !onFocusRoom) return;
              e.stopPropagation();

              // Counted off the native event rather than taken from R3F's
              // `onDoubleClick`, which never arrives on a mesh here. It also
              // removes a real hazard: the first click flies the camera to the
              // room, so by the time the second lands the model has moved under
              // the pointer, and two separate handlers would have to agree
              // about an object that is no longer where it was.
              if ((e.nativeEvent as MouseEvent).detail >= 2) {
                onEnterRoom?.(surface.roomId);
                return;
              }

              onPick?.({ roomId: surface.roomId, element: surface.element });
              // Focusing a room already focused is a no-op all the way down -
              // the state does not change, so the camera does not move. That is
              // what lets you grade four fixtures in a bathroom without the
              // view flying to it four times.
              onFocusRoom?.(surface.roomId);
            }}
          >
            <meshStandardMaterial
              // The texture already carries the colour, so tinting it again
              // would darken every surface by its own shade.
              color={surface.surface ? "#ffffff" : surface.colour}
              map={surface.surface?.map}
              normalMap={surface.surface?.normalMap}
              // One texture, three channels, three maps. three.js reads red for
              // occlusion, green for roughness and blue for metalness, so the
              // same image serves all three and only uploads once.
              aoMap={surface.surface?.ormMap}
              roughnessMap={surface.surface?.ormMap}
              metalnessMap={surface.surface?.ormMap}
              aoMapIntensity={0.9}
              // The map supplies the variation; these are the ceiling it varies
              // under. Without a map they are the whole answer, which is the
              // server-rendered and no-canvas case.
              roughness={
                surface.surface
                  ? 1
                  : surface.staging
                    // Upholstery and painted timber, which is most of what is
                    // standing in a room: soft, and nearly matte.
                    ? 0.72
                    : surface.element === "floor"
                      ? 0.78
                      : 0.9
              }
              metalness={surface.surface ? 1 : 0}
              // A painted wall is not a mirror. Left at 1 the environment
              // washes every pale surface out to white.
              envMapIntensity={
                surface.staging
                  ? 0.45
                  : surface.element === "floor"
                    ? 0.6
                    : // A ceiling is the one surface no light source reaches.
                      // The sun is above it, the lamps hang below it, and a
                      // window throws light at the floor. Everything it is lit
                      // by is bounce, so the environment is not a subtlety
                      // there - it is nearly the whole answer.
                      surface.element === "ceiling"
                      ? 0.85
                      : 0.35
              }
              transparent={ghosted}
              opacity={opacityFor(surface.roomId)}
              // Lifting what is selected rather than tinting it: a colour shift
              // would fight the palette, and on a pale model a slight glow reads
              // as "this one" without looking like a different material.
              emissive={selected ? "#4bb3fd" : "#000000"}
              emissiveIntensity={selected ? 0.32 : 0}
            />
          </mesh>
        );
      })}

      {/* One merged mesh for the whole storey's partitions, so it cannot be
          dimmed a room at a time - it goes with the rest of the house. */}
      {!exploded && built.interior && (
        <mesh geometry={built.interior} castShadow receiveShadow>
          <meshStandardMaterial
            color={scheme.wall}
            roughness={0.95}
            metalness={0}
            envMapIntensity={0.35}
            transparent={ghosted}
            opacity={dimmed}
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
          opacity={dimmed}
          walking={walking}
          colour={scheme.wallExterior}
        />
      )}

      {!exploded && built.frames && (
        <mesh geometry={built.frames}>
          <meshStandardMaterial
            color={PALETTE.frame}
            roughness={0.45}
            metalness={0}
            envMapIntensity={0.7}
            transparent={ghosted}
            opacity={dimmed}
          />
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
            roughness={0.04}
            metalness={0}
            // Glass is the one surface that should take the environment whole:
            // what makes a pane read as glass rather than as a pale panel is
            // that it reflects the sky, and now there is a sky to reflect.
            envMapIntensity={1.6}
            transparent
            opacity={dimmed * 0.92}
          />
        </mesh>
      )}
    </group>
  );
}

export function Model({
  plan,
  spec,
  opacity = 1,
  showLabels,
  displayUnits,
  onlyLevel,
  furnished = false,
  pick = null,
  onPick,
  onFocusRoom,
  onEnterRoom,
  onHover,
  onMeasurePoint,
  walking = false,
  scheme = DEFAULT_SCHEME,
  explode = 0,
  focusRoomId = null,
}: {
  plan: Plan;
  /** What each room is made of. Absent means fall back to the scheme. */
  spec?: HouseSpec | null;
  /**
   * Below 1 only while the house is being ghosted for focus.
   *
   * It used to be driven from outside as well, to sit the model back behind a
   * photograph fading up over it. Nothing fades up over it any more, so the
   * default is solid and the ghosting is the only caller left.
   */
  opacity?: number;
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
  /**
   * A single click, as "look at this room on its own".
   *
   * Keyed on the room and never on the element. Staging falls through to
   * `"floor"` rather than reporting its room, so a click on a sofa carries an
   * element that is a lie about what was hit - fine for the scope pane, which
   * wants flooring lines either way, and wrong for anything that moves a camera.
   */
  onFocusRoom?: (roomId: string) => void;
  /** A double click, as "put me in this room". */
  onEnterRoom?: (roomId: string) => void;
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
  /**
   * One room to hold at full strength while the rest of the house recedes.
   *
   * Dollhouse only. Inside the house on foot there is nothing to compare the
   * room against - you are in it - and fading the walls around you would only
   * make the building look like it was dissolving.
   */
  focusRoomId?: string | null;
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
          spec={spec}
          level={level}
          opacity={opacity}
          furnished={furnished}
          walking={walking}
          scheme={scheme}
          explode={explode}
          focusRoomId={focusRoomId}
          pick={pick}
          onPick={onPick}
          onFocusRoom={onFocusRoom}
          onEnterRoom={onEnterRoom}
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
              // On the wrapper, not just on the content.
              //
              // A label is a caption, never a target - but `Html` positions its
              // own div over the canvas, and that div takes pointer events even
              // when everything inside it is `pointer-events-none`. Since the
              // label sits at the room's centroid, it covered exactly the spot
              // where the room's own floor marker is drawn: the marker rendered,
              // reported itself hittable, and silently never received a click.
              style={{ pointerEvents: "none" }}
            >
              <div
                className="pointer-events-none select-none text-center transition-opacity"
                // A label as bright as the focused room's, on a room that has
                // faded to a ghost, competes with the one thing being looked at.
                style={{
                  opacity: focusRoomId && room.id !== focusRoomId ? 0.25 : 1,
                }}
              >
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
