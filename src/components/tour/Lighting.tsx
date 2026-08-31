"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";

import { explodeLift, explodeOffset } from "@/lib/model/room-shell";
import { windowsForLevel } from "@/lib/model/windows";
import { levelBase, levelsOf, planToWorld } from "@/lib/plan/geometry";
import { sunState } from "@/lib/model/sun";
import { EnvRig } from "@/components/tour/EnvRig";
import { boundsOf } from "@/lib/plan/autolayout";
import { roomKind } from "@/lib/plan/room-kind";
import { SHADOW_SIZE, type Quality } from "@/lib/render/quality";
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
  levels = null,
  quality = "medium",
}: {
  site: Site | null | undefined;
  dayOfYear: number;
  hour: number;
  interior: boolean;
  plan: Plan;
  lamps: boolean;
  /** Lamps travel with the rooms they light. */
  explode?: number;
  /**
   * Which storeys are on screen, or null for all of them.
   *
   * Only the window lights care. They are the most expensive lights in the
   * scene and there is one pair per window in the building, so lighting a
   * storey nobody is looking at is pure cost.
   */
  levels?: number[] | null;
  /** Decides the shadow map's resolution, and nothing else here. */
  quality?: Quality;
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
        <EnvRig sun={null} />
        {interior && <WindowLights plan={plan} sun={null} levels={levels} />}
        {/*
          Both of these are far lower than they were. The environment now
          supplies the fill they used to be entirely responsible for, and left
          at their old values the two stack: every surface goes pale, and a
          model with no dark surfaces has no form.
        */}
        <hemisphereLight args={["#eef4fb", "#6f6b64", 0.22]} />
        <ambientLight intensity={0.04} />
        <directionalLight
          position={[9, 16, 7]}
          intensity={1.9}
          castShadow
          shadow-mapSize={[SHADOW_SIZE[quality], SHADOW_SIZE[quality]]}
          shadow-camera-left={-SHADOW_EXTENT}
          shadow-camera-right={SHADOW_EXTENT}
          shadow-camera-top={SHADOW_EXTENT}
          shadow-camera-bottom={-SHADOW_EXTENT}
          shadow-camera-near={0.5}
          shadow-camera-far={80}
          shadow-bias={-0.0004}
        />
        <directionalLight position={[-8, 6, -6]} intensity={0.28} />
      </>
    );
  }

  return (
    <>
      {/*
        One sun, and the only shadow-caster in the scene.

        The map is the same 2048 it always was, but it is now the only one,
        which is what pays for the occlusion pass and the antialiasing.
      */}
      <directionalLight
        position={sun.direction}
        intensity={sun.intensity}
        color={new THREE.Color(sun.colour[0], sun.colour[1], sun.colour[2])}
        castShadow
        shadow-mapSize={[SHADOW_SIZE[quality], SHADOW_SIZE[quality]]}
        shadow-camera-left={-SHADOW_EXTENT}
        shadow-camera-right={SHADOW_EXTENT}
        shadow-camera-top={SHADOW_EXTENT}
        shadow-camera-bottom={-SHADOW_EXTENT}
        shadow-camera-near={0.5}
        shadow-camera-far={140}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />

      {interior && <WindowLights plan={plan} sun={sun} levels={levels} />}

      {/*
        The sky, as something to reflect and be lit by.

        Five directional lights used to stand in for the dome here, each with
        its own shadow map - six shadow maps a frame at noon, and the single
        largest cost in the scene. They were approximating two different
        things at once: light arriving from everywhere, and the contact
        darkening where surfaces meet. An environment map does the first
        properly and for free, and screen-space occlusion does the second.
      */}
      <EnvRig sun={sun} />

      {/*
        Just enough to keep a shadowed corner from going black.

        Lower than it was, because the environment is now carrying the fill
        that this used to fake. Ambient light is flat by definition - every
        surface comes back the same tone whichever way it faces - so the less
        of the total it accounts for, the more form the model has.

        The floor under it is deliberate and is not physics. A real house at
        seven in the evening is genuinely dim inside, and a faithful render of
        that is a property nobody can look at.
      */}
      <ambientLight intensity={(interior ? 0.16 : 0.1) + 0.08 * sun.day} />
      {lampLights}
    </>
  );
}

/**
 * Every window is a light.
 *
 * This is the piece that makes an interior read as an interior, and it
 * replaces something that used to be faked. Five directional lights sampling
 * the sky dome sat here, each casting its own shadow map, and indoors they did
 * most of the work - the key light reaches only whatever the windows let
 * through, so without them a room was lit by flat ambient and had no form at
 * all. An environment map alone does not fix that: image-based lighting
 * ignores occlusion, so it lights the inside of a sealed box exactly as
 * brightly as the outside, and every wall comes back the same tone.
 *
 * A window genuinely *is* an area light - a rectangle of sky, facing into the
 * room - so modelling it as one is both cheaper than five shadow maps and more
 * nearly true. It gives a room the thing it was missing: light that falls off
 * with distance from the openings, so the wall beside a window is brighter
 * than the wall opposite it.
 *
 * These cast no shadows - `RectAreaLight` cannot - which is the same trade the
 * ceiling lamps below already make, and for the same reason: a room lit
 * without shadows is a far smaller lie than a room nobody can see into.
 */
function WindowLights({
  plan,
  sun,
  levels,
}: {
  plan: Plan;
  sun: ReturnType<typeof sunState> | null;
  levels: number[] | null;
}) {
  useEffect(() => {
    // The area-light shading model is not compiled into three by default.
    // Without this every RectAreaLight silently contributes nothing at all.
    void import("three/examples/jsm/lights/RectAreaLightUniformsLib.js").then((m) =>
      m.RectAreaLightUniformsLib.init(),
    );
  }, []);

  const lights = useMemo(
    () =>
      // Only the storeys on screen.
      //
      // This used to be every storey in the building. A rectangle light is the
      // most expensive shading model three has, there are two per window so the
      // room is lit from whichever side you are on, and `MeshStandardMaterial`
      // is forward-shaded - so every one of them is evaluated for every
      // fragment whether or not its floor is visible. A twenty-window house
      // over two storeys was paying for forty of them to light an upstairs
      // nobody was looking at.
      (levels ?? levelsOf(plan)).flatMap((level) =>
        windowsForLevel(plan, level).map((window, i) => {
          const base = levelBase(plan, level);
          const height = window.head - window.sill;
          const [x, y, z] = planToWorld(window.center, base + (window.sill + window.head) / 2);
          return {
            key: `${level}-${i}`,
            position: [x, y, z] as [number, number, number],
            width: window.width,
            height,
            // The wall's own angle, turned to face into the room. Which of the
            // two normals points inward does not matter: a rectangle light
            // emits from one face, and getting it backwards is visible
            // immediately as a room that stays dark.
            angle: (window.angleDeg * Math.PI) / 180,
          };
        }),
      ),
    [plan, levels],
  );

  // Daylight through the glass, so a window at dusk stops lighting the room.
  const day = sun ? Math.max(0.12, sun.day) : 0.85;
  //
  // Barely tinted, and this matters more than it looks. The sky really is
  // blue and a north-facing room really is cool, but a window light carrying
  // the sky's full saturation paints the whole room with it - white walls come
  // back pale blue, and the model reads as colour-cast rather than as lit.
  // What sells daylight is the falloff, not the hue, so most of the tint is
  // mixed back out towards white.
  const colour = sun
    ? new THREE.Color(sun.sky[0], sun.sky[1], sun.sky[2]).lerp(new THREE.Color("#ffffff"), 0.72)
    : new THREE.Color("#eef3fa");

  return (
    <>
      {lights.map((light) => (
        <RectLight
          key={light.key}
          position={light.position}
          width={light.width}
          height={light.height}
          angle={light.angle}
          intensity={1.35 * day}
          colour={colour}
        />
      ))}
    </>
  );
}

/**
 * One window's worth of daylight.
 *
 * Both faces are lit rather than one, because which side of the wall is
 * "inside" is not known here - the same window serves a room on one side and
 * the outdoors on the other. Two lights back to back costs one extra light and
 * removes an entire class of "why is this room black" bug.
 */
function RectLight({
  position,
  width,
  height,
  angle,
  intensity,
  colour,
}: {
  position: [number, number, number];
  width: number;
  height: number;
  angle: number;
  intensity: number;
  colour: THREE.Color;
}) {
  return (
    <>
      <rectAreaLight
        position={position}
        rotation={[0, angle, 0]}
        width={width}
        height={height}
        intensity={intensity}
        color={colour}
      />
      <rectAreaLight
        position={position}
        rotation={[0, angle + Math.PI, 0]}
        width={width}
        height={height}
        intensity={intensity}
        color={colour}
      />
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
