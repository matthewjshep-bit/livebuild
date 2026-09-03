"use client";

import { Html } from "@react-three/drei";
import { useMemo } from "react";
import * as THREE from "three";

import { kerbGeometry, ribbonGeometry } from "@/lib/model/site-geometry";
import { merged, slabGeometry } from "@/lib/model/solids";
import { TEXTURE_METRES, applyWorldUvs, asphaltSurface, canTexture, floorSurface } from "@/lib/model/textures";
import { centroid, pointInPolygon } from "@/lib/plan/geometry";
import { type Lot, deriveLot, houseBounds } from "@/lib/site/lot";
import { type PlanSite, closestPointOnWays, roadWidth } from "@/lib/site/plan-site";
import type { Exterior, Plan, Site, Vec2 } from "@/lib/schema";

/**
 * The house on its street.
 *
 * Everything outside the walls: the lot, the roads with their names where
 * they pass the house, the buildings next door as grey masses, and the ground
 * beyond all of it. All of it in the plan's own metres, projected from the
 * map through the same frame the building was squared up in - so a road is
 * at its true angle and distance to the wall, which is what a photograph
 * taken from it shows.
 *
 * Nothing here when the house has no surroundings. A house drawn by hand
 * floats where it always floated.
 */

const LAWN = "#8fa37a";
const TERRAIN = "#7d8a70";
const NEIGHBOUR = "#b9b7b2";

export function SiteModel({
  plan,
  site,
  planSite,
  exterior,
  showNeighbours,
  labels,
}: {
  plan: Plan;
  site: Site | null | undefined;
  planSite: PlanSite | null;
  exterior: Exterior | null | undefined;
  showNeighbours: boolean;
  labels: boolean;
}) {
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
    });

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
    // which are kept apart so the garden can clad its own later.
    const inLot = (outline: Vec2[]) => pointInPolygon(centroid(outline), lot.polygon);
    const mass = (b: PlanSite["buildings"][number]) => slabGeometry(b.outline, b.heightM, b.heightM);
    const neighbours = merged(
      planSite.buildings.filter((b) => !inLot(b.outline)).map(mass).filter((g): g is THREE.BufferGeometry => Boolean(g)),
    );
    const outbuildings = merged(
      planSite.buildings.filter((b) => inLot(b.outline)).map(mass).filter((g): g is THREE.BufferGeometry => Boolean(g)),
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

    const surfaces = canTexture() ? { grass: floorSurface("grass", LAWN), asphalt: asphaltSurface() } : null;
    return { lot, lawn, roads, kerbs, neighbours, outbuildings, names, surfaces };
  }, [plan, site, planSite, exterior]);

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
          <meshStandardMaterial
            color={surfaces ? "#ffffff" : LAWN}
            map={surfaces?.grass.map}
            normalMap={surfaces?.grass.normalMap}
            aoMap={surfaces?.grass.ormMap}
            roughnessMap={surfaces?.grass.ormMap}
            metalnessMap={surfaces?.grass.ormMap}
            roughness={surfaces ? 1 : 0.95}
            metalness={surfaces ? 1 : 0}
            envMapIntensity={0.3}
          />
        </mesh>
      )}

      {built.roads && (
        <mesh geometry={built.roads} receiveShadow userData={{ element: "street" }}>
          <meshStandardMaterial
            color={surfaces ? "#ffffff" : "#4a4b4d"}
            map={surfaces?.asphalt.map}
            normalMap={surfaces?.asphalt.normalMap}
            aoMap={surfaces?.asphalt.ormMap}
            roughnessMap={surfaces?.asphalt.ormMap}
            metalnessMap={surfaces?.asphalt.ormMap}
            roughness={surfaces ? 1 : 0.92}
            metalness={surfaces ? 1 : 0}
            envMapIntensity={0.25}
          />
        </mesh>
      )}
      {built.kerbs && (
        <mesh geometry={built.kerbs} receiveShadow userData={{ element: "kerb" }}>
          <meshStandardMaterial color="#a9a7a2" roughness={0.9} metalness={0} />
        </mesh>
      )}

      {showNeighbours && built.neighbours && (
        <mesh geometry={built.neighbours} castShadow receiveShadow userData={{ element: "neighbour" }}>
          <meshStandardMaterial color={NEIGHBOUR} roughness={0.95} metalness={0} />
        </mesh>
      )}
      {built.outbuildings && (
        <mesh geometry={built.outbuildings} castShadow receiveShadow userData={{ element: "outbuilding" }}>
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
