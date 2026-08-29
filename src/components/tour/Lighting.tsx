"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";

import { explodeLift, explodeOffset } from "@/lib/model/room-shell";
import { SKY_RAYS, sunState } from "@/lib/model/sun";
import { boundsOf } from "@/lib/plan/autolayout";
import { levelBase } from "@/lib/plan/geometry";
import { roomKind } from "@/lib/plan/room-kind";
import type { Plan, Site } from "@/lib/schema";

/**
 * Daylight, from where the house actually is.
 *
 * A fixed key light lights a model; a solar position lights a house. Which
 * rooms get the morning, whether the kitchen is dark by four in December, how
 * far the sun reaches through a south window in June - a buyer asks all of
 * these, and they have real answers once the model knows its own coordinates.
 *
 * Falls back to a studio key light when there is no site, which is every house
 * built from photographs or drawn by hand. That is not a degraded mode so much
 * as an honest one: without knowing where the building is, a sun angle would be
 * decoration pretending to be information.
 */

/** Bounds of the shadow camera, in metres. Comfortably larger than a house. */
const SHADOW_EXTENT = 26;

export function Lighting({
  site,
  dayOfYear,
  hour,
  /** True indoors, where the sky matters more than the key light. */
  interior,
  plan,
  lamps,
  explode = 0,
}: {
  site: Site | null | undefined;
  dayOfYear: number;
  hour: number;
  interior: boolean;
  plan: Plan;
  lamps: boolean;
  /** Lamps travel with the rooms they light. */
  explode?: number;
}) {
  const scene = useThree((s) => s.scene);
  const sun = useMemo(
    () => (site ? sunState(site, dayOfYear, hour) : null),
    [site, dayOfYear, hour],
  );

  useEffect(() => {
    if (!sun) return;
    scene.background = new THREE.Color(sun.sky[0], sun.sky[1], sun.sky[2]);
  }, [scene, sun]);

  const lampLights = lamps ? <Lamps plan={plan} explode={explode} /> : null;

  if (!sun) {
    return (
      <>
        {lampLights}
        {/*
          No site, so no sun. One key light with real shadows, a cool sky fill
          and very little ambient - flat ambient light is what made the old
          dollhouse read as a diagram, since every surface came back the same
          tone and nothing had form.
        */}
        <hemisphereLight args={["#eef4fb", "#6f6b64", 1.05]} />
        <ambientLight intensity={0.22} />
        <directionalLight
          position={[9, 16, 7]}
          intensity={1.9}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-SHADOW_EXTENT}
          shadow-camera-right={SHADOW_EXTENT}
          shadow-camera-top={SHADOW_EXTENT}
          shadow-camera-bottom={-SHADOW_EXTENT}
          shadow-camera-near={0.5}
          shadow-camera-far={80}
          shadow-bias={-0.0004}
        />
        <directionalLight position={[-8, 6, -6]} intensity={0.32} />
      </>
    );
  }

  return (
    <>
      <directionalLight
        position={sun.direction}
        intensity={sun.intensity}
        color={new THREE.Color(sun.colour[0], sun.colour[1], sun.colour[2])}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-SHADOW_EXTENT}
        shadow-camera-right={SHADOW_EXTENT}
        shadow-camera-top={SHADOW_EXTENT}
        shadow-camera-bottom={-SHADOW_EXTENT}
        shadow-camera-near={0.5}
        shadow-camera-far={140}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />

      {/*
        A coarse sample of the sky dome, each ray casting its own shadow.
        
        Five directions is enough to separate "under a window" from "deep in the
        plan" without a shadow map per degree, and it is what makes an interior
        read as lit by the sky rather than by a lamp hidden in the ceiling.
        Indoors it does most of the work, since the one key light reaches only
        whatever the windows let through.
      */}
      {SKY_RAYS.map((ray, i) => (
        <directionalLight
          key={i}
          position={[ray.direction[0] * 55, ray.direction[1] * 55, ray.direction[2] * 55]}
          //
          // The floor of 0.55 is a deliberate departure from the physics. A
          // real house at seven in the evening is genuinely dim inside, and a
          // faithful render of that is a property you cannot look at. The sky
          // still brightens through the day - it simply never drops to the
          // point where the model stops being legible.
          intensity={ray.weight * (0.55 + 0.9 * sun.day) * (interior ? 1.7 : 1.35)}
          color="#cfe0f5"
          castShadow
          shadow-mapSize={[1024, 1024]}
          shadow-camera-left={-SHADOW_EXTENT}
          shadow-camera-right={SHADOW_EXTENT}
          shadow-camera-top={SHADOW_EXTENT}
          shadow-camera-bottom={-SHADOW_EXTENT}
          shadow-camera-near={0.5}
          shadow-camera-far={140}
          shadow-bias={-0.0006}
          shadow-normalBias={0.03}
        />
      ))}

      {/* Just enough to keep a shadowed corner from going black. */}
      <ambientLight intensity={0.2 + 0.12 * sun.day} />
      {lampLights}
    </>
  );
}

/**
 * A light in the middle of each room's ceiling.
 *
 * Daylight only reaches where a window lets it, which is correct and leaves the
 * middle of a plan dim in the afternoon and unusable after dark. A house has
 * lights in it; modelling that is both more honest and the difference between
 * a tour you can take at any hour and one that only works at noon.
 *
 * No shadows from these. Twenty shadow-casting lights would cost more than the
 * rest of the scene put together, and a ceiling light casting no shadow is a
 * far smaller lie than a room nobody can see.
 */
function Lamps({ plan, explode }: { plan: Plan; explode: number }) {
  const positions = useMemo(
    () =>
      plan.rooms
        // Nothing outdoors, and nothing in a cupboard.
        .filter((room) => {
          const kind = roomKind(room.label);
          return kind !== "outside" && kind !== "closet";
        })
        .map((room) => {
          const b = boundsOf(room.polygon);
          // A lamp left behind would light the gap the room came out of.
          const [dx, dy] = explodeOffset(plan, room, explode);
          return {
            id: room.id,
            position: [
              (b.x0 + b.x1) / 2 + dx,
              levelBase(plan, room.level) + room.ceilingHeight - 0.25 + explodeLift(room.level, explode),
              (b.y0 + b.y1) / 2 + dy,
            ] as [number, number, number],
            // Bigger rooms get a longer reach, so a hallway is not as bright as
            // a living room lit by the same fitting.
            distance: Math.max(3.5, Math.hypot(b.x1 - b.x0, b.y1 - b.y0) * 0.9),
          };
        }),
    [plan, explode],
  );

  return (
    <>
      {positions.map((lamp) => (
        <pointLight
          key={lamp.id}
          position={lamp.position}
          intensity={2.4}
          distance={lamp.distance}
          decay={1.6}
          color="#ffe9c9"
        />
      ))}
    </>
  );
}
