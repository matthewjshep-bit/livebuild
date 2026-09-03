"use client";

import { Html } from "@react-three/drei";
import { useMemo } from "react";
import * as THREE from "three";

import { exteriorLook } from "@/lib/model/exterior-look";
import { type Landscape, landscapeFor } from "@/lib/model/landscape";
import { roofGeometry, roofOverRect } from "@/lib/model/roof";
import { type Scheme, toHex } from "@/lib/model/schemes";
import { sidingFinish } from "@/lib/model/siding";
import { kerbGeometry, ribbonGeometry } from "@/lib/model/site-geometry";
import { windowsForLevel } from "@/lib/model/windows";
import { boxGeometry, coneGeometry, cylinderGeometry, merged, slabGeometry, sphereGeometry } from "@/lib/model/solids";
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
import { centroid, pointInPolygon } from "@/lib/plan/geometry";
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

type Textured = { geometry: THREE.BufferGeometry; surface: Surface | null; colour: string; element: string };

/** A material for a surface, or a flat colour when textures cannot be made. */
function Material({ surface, colour, roughness = 0.95, env = 0.3 }: { surface: Surface | null; colour: string; roughness?: number; env?: number }) {
  return <meshStandardMaterial {...surfaceProps(surface, { colour, roughness }, env)} />;
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
    if (lawn) applyWorldUvs(lawn, TEXTURE_METRES.floor);

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

    // Next door's buildings, and the ones on this lot - a detached garage -
    // which are the garden's to clad.
    const inLot = (outline: Vec2[]) => pointInPolygon(centroid(outline), lot.polygon);
    const neighbours = merged(
      planSite.buildings
        .filter((b) => !inLot(b.outline))
        .map((b) => slabGeometry(b.outline, b.heightM, b.heightM))
        .filter((g): g is THREE.BufferGeometry => Boolean(g)),
    );

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
    const door = garden.door ? boxGeometry(garden.door.center, garden.door.size) : null;

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
    }
    const fence = merged(fenceParts);
    const fenceColour = garden.fence[0]?.colour ?? "#8a6a45";

    const trunks = merged(
      garden.trees.map((t) => {
        const trunkH = t.shape === "cone" ? t.heightM * 0.25 : t.heightM - t.canopyR * 1.6;
        return cylinderGeometry([t.at[0], trunkH / 2, t.at[1]], t.trunkR, trunkH);
      }),
    );
    const canopies = new Map<string, THREE.BufferGeometry[]>();
    for (const t of garden.trees) {
      const trunkH = t.shape === "cone" ? t.heightM * 0.25 : t.heightM - t.canopyR * 1.6;
      const g =
        t.shape === "cone"
          ? coneGeometry([t.at[0], trunkH + (t.heightM - trunkH) / 2, t.at[1]], t.canopyR, t.heightM - trunkH)
          : sphereGeometry([t.at[0], trunkH + t.canopyR * 0.9, t.at[1]], t.canopyR);
      (canopies.get(t.colour) ?? canopies.set(t.colour, []).get(t.colour)!).push(g);
    }
    for (const s of garden.shrubs) {
      (canopies.get(s.colour) ?? canopies.set(s.colour, []).get(s.colour)!).push(sphereGeometry([s.at[0], s.r * 0.8, s.at[1]], s.r));
    }
    for (const h of garden.hedges) {
      const g = alongSegment(h.a, h.b, h.heightM / 2, h.heightM, h.depthM, 0.3);
      if (g) (canopies.get(h.colour) ?? canopies.set(h.colour, []).get(h.colour)!).push(g);
    }
    const planting: Textured[] = [...canopies].flatMap(([colour, parts]) => {
      const g = merged(parts);
      if (!g) return [];
      applyWorldUvs(g, 1.5);
      return [{ geometry: g, surface: textures ? foliageSurface(colour) : null, colour, element: "planting" }];
    });

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
      neighbours,
      names,
      surfaces,
      hard,
      porch,
      door,
      doorColour: garden.door?.colour ?? "#3c3f42",
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
      {built.door && (
        <mesh geometry={built.door} castShadow receiveShadow userData={{ element: "porch" }}>
          <meshStandardMaterial color={built.doorColour} roughness={0.6} metalness={0} />
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
          <Material surface={p.surface} colour={p.colour} env={0.35} />
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
