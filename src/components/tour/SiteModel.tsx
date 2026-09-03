"use client";

import { Html } from "@react-three/drei";
import { useMemo } from "react";
import * as THREE from "three";

import { exteriorLook } from "@/lib/model/exterior-look";
import { doorAssembly } from "@/lib/model/door-assembly";
import { type Landscape, landscapeFor } from "@/lib/model/landscape";
import { roofGeometry, roofOverRect } from "@/lib/model/roof";
import { type Scheme, toHex } from "@/lib/model/schemes";
import { sidingFinish } from "@/lib/model/siding";
import { kerbGeometry, ribbonGeometry } from "@/lib/model/site-geometry";
import { centreDashes } from "@/lib/model/road-marks";
import { canopyGeometry, shrubGeometry, trunkGeometry } from "@/lib/model/tree-geometry";
import { windowsForLevel } from "@/lib/model/windows";
import { boxGeometry, merged, slabGeometry } from "@/lib/model/solids";
import {
  type Surface,
  TEXTURE_METRES,
  applyWorldUvs,
  asphaltSurface,
  canTexture,
  floorSurface,
  foliageSurface,
  roofSurface,
  sidingSurface,
} from "@/lib/model/textures";
import { assetForRoof, assetForSiding } from "@/lib/model/assets";
import { assetSurface, useAssetsVersion } from "@/lib/model/asset-surfaces";
import { surfaceProps } from "@/lib/model/surface-props";
import { area, centroid, pointInPolygon } from "@/lib/plan/geometry";
import { type Lot, deriveLot, houseBounds } from "@/lib/site/lot";
import { type PlanSite, closestPointOnWays, roadWidth } from "@/lib/site/plan-site";
import type { HouseSpec } from "@/lib/spec/schema";
import type { Exterior, Plan, Site, Vec2 } from "@/lib/schema";

/**
 * The house on its street, and its garden.
 *
 * Everything outside the walls: the lot, the roads with their names where
 * they pass the house, the buildings next door as grey masses, the ground
 * beyond all of it - and on the lot, what the photographs said is there: the
 * door, the path, the drive, a porch, a fence, the trees. All of it in the
 * plan's own metres, projected from the map through the same frame the
 * building was squared up in, so a road is at its true angle and distance
 * to the wall, which is what a photograph taken from it shows.
 *
 * Nothing here when the house has no surroundings. A house drawn by hand
 * floats where it always floated.
 */

const LAWN = "#8fa37a";
const TERRAIN = "#7d8a70";
const NEIGHBOUR = "#b9b7b2";
const TRUNK = "#5b4636";
const CONCRETE = "#b9b5ad";
const GRAVEL = "#a39c8f";

type Textured = { geometry: THREE.BufferGeometry; surface: Surface | null; colour: string; element: string; vertexColours?: boolean };

/** A material for a surface, or a flat colour when textures cannot be made. */
function Material({
  surface,
  colour,
  roughness = 0.95,
  env = 0.3,
  vertexColors = false,
}: {
  surface: Surface | null;
  colour: string;
  roughness?: number;
  env?: number;
  /** The geometry carries a shade of its own, multiplied into the colour: a crown's underside. */
  vertexColors?: boolean;
}) {
  return <meshStandardMaterial {...surfaceProps(surface, { colour, roughness }, env)} vertexColors={vertexColors} />;
}

/** A box along a segment on the ground. */
function alongSegment(a: Vec2, b: Vec2, y: number, height: number, depth: number, inset = 0): THREE.BufferGeometry | null {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz) - inset * 2;
  if (len < 0.05) return null;
  return boxGeometry([(a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2], [len, height, depth], -Math.atan2(dz, dx));
}

export function SiteModel({
  plan,
  site,
  planSite,
  exterior,
  spec,
  scheme,
  showNeighbours,
  labels,
}: {
  plan: Plan;
  site: Site | null | undefined;
  planSite: PlanSite | null;
  exterior: Exterior | null | undefined;
  spec: HouseSpec | null | undefined;
  scheme: Scheme;
  showNeighbours: boolean;
  labels: boolean;
}) {
  const assetsVersion = useAssetsVersion();
  const built = useMemo(() => {
    if (!planSite) return null;
    const house = houseBounds(plan);
    if (!house) return null;
    const lot: Lot = deriveLot({
      house,
      site: planSite,
      frontDoorBearing: exterior?.frontDoorBearing ?? null,
      garageBearing: exterior?.garage?.bearing ?? null,
      planXBearing: site?.planXBearing ?? 90,
      windows: windowsForLevel(plan, Math.min(...plan.rooms.map((r) => r.level))).map((w) => ({ center: w.center, width: w.width })),
    });
    const textures = canTexture();

    const lawn = slabGeometry(lot.polygon, -0.03, 0.05);
    // Four metres to the tile rather than two: the blades come out a little
    // coarser and the slow blotches drawn into the grass repeat over a
    // distance the eye does not catch from the kerb.
    if (lawn) applyWorldUvs(lawn, 4);

    const roads = merged(
      planSite.streets.flatMap((s) =>
        s.ways
          .map((way) => ribbonGeometry(way, roadWidth(s.kind), -0.02))
          .filter((g): g is THREE.BufferGeometry => Boolean(g)),
      ),
    );
    if (roads) applyWorldUvs(roads, TEXTURE_METRES.floor);
    const kerbs = merged(
      planSite.streets.flatMap((s) => s.ways.flatMap((way) => kerbGeometry(way, roadWidth(s.kind), -0.01))),
    );
    // The broken centre line down each road, a hair above the asphalt.
    const marks = merged(planSite.streets.flatMap((s) => s.ways.flatMap((way) => centreDashes(way, -0.017))));

    // Next door's buildings, and the ones on this lot - a detached garage -
    // which are the garden's to clad.
    const inLot = (outline: Vec2[]) => pointInPolygon(centroid(outline), lot.polygon);
    // Next door as walls to the eave and, where the outline is near enough a
    // rectangle to carry one, a hip roof over it. A grey box with a flat top
    // is a warehouse; most of what is next door is a house.
    const neighbourWalls: THREE.BufferGeometry[] = [];
    const neighbourRoofParts: THREE.BufferGeometry[] = [];
    for (const b of planSite.buildings) {
      if (inLot(b.outline)) continue;
      const walls = slabGeometry(b.outline, b.heightM, b.heightM);
      if (walls) neighbourWalls.push(walls);
      const xs = b.outline.map((p) => p[0]);
      const ys = b.outline.map((p) => p[1]);
      const rect = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      const boxArea = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
      if (boxArea > 20 && Math.abs(area(b.outline)) / boxArea > 0.78) {
        const roof = roofGeometry(roofOverRect(rect, "hip", b.heightM, 22, rect.x1 - rect.x0 >= rect.y1 - rect.y0), "slope");
        if (roof) neighbourRoofParts.push(roof);
      }
    }
    const neighbours = merged(neighbourWalls);
    const neighbourRoofs = merged(neighbourRoofParts);

    /**
     * The name where the road passes the house, lying on the road.
     *
     * The drawing pad's rule, kept: the middle of a road is off the edge of
     * anything that shows a house. Turned to run along the road and flipped
     * so it reads the right way up from the house's side.
     */
    const houseCentre: Vec2 = [(house.x0 + house.x1) / 2, (house.y0 + house.y1) / 2];
    const names = planSite.streets
      .map((s) => {
        const near = closestPointOnWays(s.ways, houseCentre);
        if (!near) return null;
        let deg = (Math.atan2(near.along[1], near.along[0]) * 180) / Math.PI;
        // A name on the ground reads from the house when its top points away
        // from it - a sheet on the floor is read with its top furthest from
        // you. The text's "up" after turning is (sin, -cos); flip when that
        // points toward the house.
        const rad = (deg * Math.PI) / 180;
        const up: Vec2 = [Math.sin(rad), -Math.cos(rad)];
        const toHouse: Vec2 = [houseCentre[0] - near.point[0], houseCentre[1] - near.point[1]];
        if (up[0] * toHouse[0] + up[1] * toHouse[1] > 0) deg += 180;
        deg = ((deg % 360) + 360) % 360;
        return { name: s.name, at: near.point, deg };
      })
      .filter((n): n is { name: string; at: Vec2; deg: number } => Boolean(n));

    /**
     * The garden: what the photographs said is there, where it goes.
     *
     * Hardstanding sits a centimetre above the lawn and a centimetre below
     * anything standing on it, so nothing fights for the same plane.
     */
    const look = exteriorLook(spec, exterior);
    const garden: Landscape = landscapeFor({
      lot,
      house,
      features: spec?.exterior?.features ?? [],
      outbuildings: planSite.buildings.filter((b) => inLot(b.outline)).map((b) => ({ outline: b.outline, kind: b.kind })),
      garageBays: exterior?.garage?.bays ?? null,
      doorColour: look.doorColour,
    });

    // Scans when they have landed, the drawn surfaces until then.
    const concrete = textures ? assetSurface("ground-concrete", TEXTURE_METRES.floor, CONCRETE) ?? floorSurface("concrete", CONCRETE) : null;
    const gravel = textures ? assetSurface("ground-gravel", TEXTURE_METRES.floor, GRAVEL) ?? floorSurface("concrete", GRAVEL) : null;
    const asphalt = textures ? assetSurface("ground-asphalt", TEXTURE_METRES.floor, null) ?? asphaltSurface() : null;
    const sidingKind = sidingFinish(look.wallMaterial);
    const siding = textures
      ? assetSurface(assetForSiding(sidingKind), TEXTURE_METRES.wall, look.wallColour ?? scheme.wallExterior) ?? sidingSurface(sidingKind, scheme.wallExterior)
      : null;
    const roofColour = toHex(look.roofColour) ?? "#4b4b4d";
    const roof = textures ? assetSurface(assetForRoof(look.roofMaterial), 2, roofColour) ?? roofSurface(roofColour) : null;

    const hard: Textured[] = [];
    if (garden.driveway) {
      const g = slabGeometry(garden.driveway.polygon, -0.02, 0.04);
      if (g) {
        applyWorldUvs(g, TEXTURE_METRES.floor);
        const material = garden.driveway.material;
        hard.push({
          geometry: g,
          surface: material === "asphalt" ? asphalt : material === "gravel" ? gravel : concrete,
          colour: material === "asphalt" ? "#4a4b4d" : material === "gravel" ? GRAVEL : CONCRETE,
          element: "driveway",
        });
      }
    }
    if (garden.path) {
      const g = slabGeometry(garden.path, -0.015, 0.03);
      if (g) {
        applyWorldUvs(g, TEXTURE_METRES.floor);
        hard.push({ geometry: g, surface: concrete, colour: CONCRETE, element: "driveway" });
      }
    }

    const porch = merged([...garden.porch, ...garden.steps].map((b) => boxGeometry(b.center, b.size)));
    // The posts and the roof they hold, in the trim colour.
    const porchTrim = merged([...garden.posts, ...garden.porchRoof].map((b) => boxGeometry(b.center, b.size)));
    // The front door as fitted: a frame, a six-panel leaf, a threshold, a
    // handle and casing - by part, since the leaf, the joinery and the
    // handle are three colours.
    const trimColour = look.trimColour ?? "#f0ede6";
    const doorParts = garden.doorAt && garden.doorOutward
      ? doorAssembly(garden.doorAt, garden.doorOutward, 0.9, 2.05, { leaf: garden.door?.colour ?? "#3c3f42", frame: trimColour, casing: trimColour })
      : [];
    const partsOf = (keep: (part: string) => boolean) =>
      merged(doorParts.filter((p) => keep(p.part)).map((p) => boxGeometry(p.center, p.size, (p.angleDeg * Math.PI) / 180)));
    const door = partsOf((part) => part === "door-leaf" || part === "door-panel");
    const doorTrim = partsOf((part) => part !== "door-leaf" && part !== "door-panel" && part !== "handle");
    const doorHandle = partsOf((part) => part === "handle");

    const fenceParts: THREE.BufferGeometry[] = [];
    for (const run of garden.fence) {
      const len = Math.hypot(run.b[0] - run.a[0], run.b[1] - run.a[1]);
      const posts = Math.max(1, Math.round(len / 2.4));
      for (let i = 0; i <= posts; i++) {
        const t = i / posts;
        fenceParts.push(boxGeometry([run.a[0] + (run.b[0] - run.a[0]) * t, run.heightM / 2, run.a[1] + (run.b[1] - run.a[1]) * t], [0.1, run.heightM, 0.1]));
      }
      for (const y of [run.heightM * 0.4, run.heightM * 0.8]) {
        const rail = alongSegment(run.a, run.b, y, 0.1, 0.04);
        if (rail) fenceParts.push(rail);
      }
      // Pickets: a board every fifteen centimetres, a little short of the
      // ground and of the posts' tops, turned to the run.
      if (run.picket) {
        const angle = Math.atan2(run.b[1] - run.a[1], run.b[0] - run.a[0]);
        const count = Math.floor(len / 0.15);
        for (let i = 1; i < count; i++) {
          const t = i / count;
          fenceParts.push(
            boxGeometry(
              [run.a[0] + (run.b[0] - run.a[0]) * t, run.heightM / 2 + 0.02, run.a[1] + (run.b[1] - run.a[1]) * t],
              [0.08, run.heightM - 0.12, 0.02],
              angle,
            ),
          );
        }
      }
    }
    const fence = merged(fenceParts);
    const fenceColour = garden.fence[0]?.colour ?? "#8a6a45";

    // Trunks with branches, crowns of several lobes, shrubs as clumps: see
    // `tree-geometry.ts`. Crowns and shrubs carry a vertex shade - darker
    // underneath - and hedges are plain boxes that do not, and geometries
    // with different attributes cannot be merged, so the two are grouped
    // apart and drawn with and without the shade.
    const trunks = merged(garden.trees.map((t) => trunkGeometry(t)));
    const crowns = new Map<string, THREE.BufferGeometry[]>();
    const hedgeRuns = new Map<string, THREE.BufferGeometry[]>();
    const into = (groups: Map<string, THREE.BufferGeometry[]>, key: string, g: THREE.BufferGeometry) =>
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(g);
    for (const t of garden.trees) into(crowns, t.colour, canopyGeometry(t));
    for (const s of garden.shrubs) into(crowns, s.colour, shrubGeometry(s));
    for (const h of garden.hedges) {
      const g = alongSegment(h.a, h.b, h.heightM / 2, h.heightM, h.depthM, 0.3);
      if (g) into(hedgeRuns, h.colour, g);
    }
    const foliage = (groups: Map<string, THREE.BufferGeometry[]>, vertexColours: boolean): Textured[] =>
      [...groups].flatMap(([colour, parts]) => {
        const g = merged(parts);
        if (!g) return [];
        applyWorldUvs(g, 1.5);
        return [{ geometry: g, surface: textures ? foliageSurface(colour) : null, colour, element: "planting", vertexColours }];
      });
    const planting: Textured[] = [...foliage(crowns, true), ...foliage(hedgeRuns, false)];

    // The house's own garage or shed, clad like the house, under its own gable.
    const outWalls: THREE.BufferGeometry[] = [];
    const outRoofs: THREE.BufferGeometry[] = [];
    const outEnds: THREE.BufferGeometry[] = [];
    for (const o of garden.outbuildings) {
      const w = o.rect.x1 - o.rect.x0;
      const d = o.rect.y1 - o.rect.y0;
      outWalls.push(boxGeometry([(o.rect.x0 + o.rect.x1) / 2, o.eaveM / 2, (o.rect.y0 + o.rect.y1) / 2], [w, o.eaveM, d]));
      const faces = roofOverRect(o.rect, "gable", o.eaveM, 25, w >= d);
      const slopes = roofGeometry(faces, "slope");
      const ends = roofGeometry(faces, "gable");
      if (slopes) outRoofs.push(slopes);
      if (ends) outEnds.push(ends);
    }
    const outbuildingWalls = merged(outWalls);
    if (outbuildingWalls) applyWorldUvs(outbuildingWalls, TEXTURE_METRES.wall);
    const outbuildingRoofs = merged(outRoofs);
    if (outbuildingRoofs) applyWorldUvs(outbuildingRoofs, 2);
    const outbuildingEnds = merged(outEnds);
    if (outbuildingEnds) applyWorldUvs(outbuildingEnds, TEXTURE_METRES.wall);

    // The lawn stays drawn: Poly Haven scans meadows and verges, not mown
    // lawns, and tinted to a lawn green they came out orange.
    const surfaces = textures ? { grass: floorSurface("grass", LAWN), asphalt } : null;
    return {
      lot,
      lawn,
      roads,
      kerbs,
      marks,
      neighbours,
      neighbourRoofs,
      names,
      surfaces,
      hard,
      porch,
      porchTrim,
      door,
      doorTrim,
      doorHandle,
      doorColour: garden.door?.colour ?? "#3c3f42",
      trimColour,
      fence,
      fenceColour,
      trunks,
      planting,
      outbuildingWalls,
      outbuildingRoofs,
      outbuildingEnds,
      siding,
      roof,
      roofColour,
    };
    // `assetsVersion` is not read: it changes when a scan lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, site, planSite, exterior, spec, scheme, assetsVersion]);

  if (!built) return null;
  const { surfaces } = built;

  return (
    <group>
      {/* The ground beyond the lot, fading into the sky. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.06, 0]} receiveShadow userData={{ element: "ground" }}>
        <circleGeometry args={[200, 48]} />
        <meshStandardMaterial color={TERRAIN} roughness={1} metalness={0} />
      </mesh>

      {built.lawn && (
        <mesh geometry={built.lawn} receiveShadow userData={{ element: "ground" }}>
          <Material surface={surfaces?.grass ?? null} colour={LAWN} />
        </mesh>
      )}

      {built.roads && (
        <mesh geometry={built.roads} receiveShadow userData={{ element: "street" }}>
          <Material surface={surfaces?.asphalt ?? null} colour="#4a4b4d" roughness={0.92} env={0.25} />
        </mesh>
      )}
      {built.kerbs && (
        <mesh geometry={built.kerbs} receiveShadow userData={{ element: "kerb" }}>
          <meshStandardMaterial color="#a9a7a2" roughness={0.9} metalness={0} />
        </mesh>
      )}
      {built.marks && (
        <mesh geometry={built.marks} receiveShadow userData={{ element: "street" }}>
          <meshStandardMaterial color="#d9d6c8" roughness={0.85} metalness={0} />
        </mesh>
      )}

      {built.hard.map((h, i) => (
        <mesh key={`hard-${i}`} geometry={h.geometry} receiveShadow userData={{ element: h.element }}>
          <Material surface={h.surface} colour={h.colour} roughness={0.9} env={0.25} />
        </mesh>
      ))}
      {built.porch && (
        <mesh geometry={built.porch} castShadow receiveShadow userData={{ element: "porch" }}>
          <meshStandardMaterial color={CONCRETE} roughness={0.9} metalness={0} />
        </mesh>
      )}
      {built.porchTrim && (
        <mesh geometry={built.porchTrim} castShadow receiveShadow userData={{ element: "porch" }}>
          <meshStandardMaterial color={built.trimColour} roughness={0.6} metalness={0} />
        </mesh>
      )}
      {built.door && (
        <mesh geometry={built.door} castShadow receiveShadow userData={{ element: "door" }}>
          <meshStandardMaterial color={built.doorColour} roughness={0.55} metalness={0} envMapIntensity={0.6} />
        </mesh>
      )}
      {built.doorTrim && (
        <mesh geometry={built.doorTrim} castShadow receiveShadow userData={{ element: "door" }}>
          <meshStandardMaterial color={built.trimColour} roughness={0.6} metalness={0} />
        </mesh>
      )}
      {built.doorHandle && (
        <mesh geometry={built.doorHandle} castShadow userData={{ element: "door" }}>
          <meshStandardMaterial color="#b8b6ae" roughness={0.3} metalness={0.85} />
        </mesh>
      )}
      {built.fence && (
        <mesh geometry={built.fence} castShadow receiveShadow userData={{ element: "fence" }}>
          <meshStandardMaterial color={built.fenceColour} roughness={0.85} metalness={0} />
        </mesh>
      )}
      {built.trunks && (
        <mesh geometry={built.trunks} castShadow receiveShadow userData={{ element: "planting" }}>
          <meshStandardMaterial color={TRUNK} roughness={0.95} metalness={0} />
        </mesh>
      )}
      {built.planting.map((p, i) => (
        <mesh key={`planting-${i}`} geometry={p.geometry} castShadow receiveShadow userData={{ element: p.element }}>
          <Material surface={p.surface} colour={p.colour} env={0.35} vertexColors={p.vertexColours ?? false} />
        </mesh>
      ))}

      {built.outbuildingWalls && (
        <mesh geometry={built.outbuildingWalls} castShadow receiveShadow userData={{ element: "outbuilding" }}>
          <Material surface={built.siding} colour={scheme.wallExterior} />
        </mesh>
      )}
      {built.outbuildingRoofs && (
        <mesh geometry={built.outbuildingRoofs} castShadow receiveShadow userData={{ element: "outbuilding" }}>
          <Material surface={built.roof} colour={built.roofColour} />
        </mesh>
      )}
      {built.outbuildingEnds && (
        <mesh geometry={built.outbuildingEnds} castShadow receiveShadow userData={{ element: "outbuilding" }}>
          <Material surface={built.siding} colour={scheme.wallExterior} />
        </mesh>
      )}

      {showNeighbours && built.neighbours && (
        <mesh geometry={built.neighbours} castShadow receiveShadow userData={{ element: "neighbour" }}>
          <meshStandardMaterial color={NEIGHBOUR} roughness={0.95} metalness={0} />
        </mesh>
      )}
      {showNeighbours && built.neighbourRoofs && (
        <mesh geometry={built.neighbourRoofs} castShadow receiveShadow userData={{ element: "neighbour" }}>
          <meshStandardMaterial color="#6c6b69" roughness={0.95} metalness={0} />
        </mesh>
      )}

      {labels &&
        built.names.map((n) => (
          <Html
            key={n.name}
            position={[n.at[0], 0.04, n.at[1]]}
            transform
            center
            distanceFactor={14}
            // Laid flat, face up - the same quarter turn a ground plane gets.
            rotation={[-Math.PI / 2, 0, 0]}
            zIndexRange={[5, 0]}
            style={{ pointerEvents: "none" }}
          >
            <div
              data-street-name
              className="pointer-events-none select-none whitespace-nowrap text-[15px] font-medium uppercase tracking-[0.3em] text-mist-100/80"
              data-street-turn={n.deg}
              style={{ transform: `rotate(${n.deg}deg)` }}
            >
              {n.name}
            </div>
          </Html>
        ))}
    </group>
  );
}
