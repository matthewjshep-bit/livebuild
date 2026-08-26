"use client";

import { PointerLockControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import {
  EYE_HEIGHT,
  type Collider,
  collidersFor,
  groundAt,
  moveWithSliding,
  startingPoint,
} from "@/lib/model/collide";
import type { Plan } from "@/lib/schema";

/**
 * Walking through the model on your own feet.
 *
 * The tour could already step between photographs and orbit the dollhouse, and
 * neither is the same thing as being inside the house. This is the mode where
 * the model stops being a diagram you inspect and becomes somewhere you are -
 * and it is the reason to have built real walls, headers above the doors and
 * textured floors at all, since none of that is legible from twenty metres up.
 *
 * Three things make the difference between this feeling smooth and feeling
 * like a prototype, all learned from reading a build that got it right:
 *
 * - Pointer lock owns the mouse look. Deltas are applied to a Euler as they
 *   arrive and the camera is never re-aimed with `lookAt`, so there is no
 *   per-frame correction to jitter against.
 * - Movement runs on a fixed timestep rather than per frame. A dropped frame
 *   then costs a dropped step instead of one enormous one, which is what
 *   otherwise throws a walker through a wall.
 * - Velocity is damped toward its target instead of snapped to it, and the eye
 *   height eases, so a stairwell reads as a climb rather than a jolt.
 */

const WALK_SPEED = 1.5; // m/s, an unhurried indoor pace
const RUN_SPEED = 3.0;
const ACCEL = 11;
const STEP = 1 / 120;
/** How fast the eye settles to the height of the floor underfoot. */
const EYE_EASE = 7;

export type WalkState = {
  /** Plan-space position, read by the minimap without re-rendering React. */
  x: number;
  y: number;
  level: number;
  yaw: number;
};

export function WalkControls({
  plan,
  level,
  onLevelChange,
  state,
  enabled,
}: {
  plan: Plan;
  level: number;
  onLevelChange: (level: number) => void;
  /** Written every frame; a ref so walking costs no React renders. */
  state: React.MutableRefObject<WalkState>;
  enabled: boolean;
}) {
  const camera = useThree((s) => s.camera);
  const keys = useRef<Record<string, boolean>>({});
  const velocity = useRef(new THREE.Vector2());
  const carry = useRef(0);
  const eye = useRef(0);

  const colliders = useMemo(() => {
    const byLevel = new Map<number, Collider[]>();
    for (const l of new Set(plan.rooms.map((r) => r.level))) {
      byLevel.set(l, collidersFor(plan, l));
    }
    return byLevel;
  }, [plan]);

  useEffect(() => {
    if (!enabled) return;
    const down = (e: KeyboardEvent) => {
      keys.current[e.key.toLowerCase()] = true;
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.key.toLowerCase()] = false;
    };
    // Keys held when the window loses focus would otherwise stick down and
    // leave the walker drifting into a wall while nobody is touching anything.
    const blur = () => {
      keys.current = {};
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [enabled]);

  // Drop the walker into the house when the mode opens.
  useEffect(() => {
    if (!enabled) return;
    const [sx, sy] = startingPoint(plan, level);
    const ground = groundAt(plan, level, sx, sy);
    state.current = { x: sx, y: sy, level, yaw: 0 };
    eye.current = ground.height + EYE_HEIGHT;
    velocity.current.set(0, 0);
    camera.position.set(sx, eye.current, sy);

    // Level the camera. Entering walk mode inherits whatever angle the
    // dollhouse orbit was left at, which is steeply downward - so the first
    // thing you see on foot is the floor at your feet, and since pointer lock
    // only changes yaw and pitch from wherever it starts, it stays wrong.
    camera.rotation.set(0, camera.rotation.y, 0, "YXZ");
    camera.up.set(0, 1, 0);

    // Wider than the dollhouse uses. A 55-degree lens indoors feels like
    // looking down a tube - rooms read as narrower than they are and you
    // cannot see the floor near your feet, which is most of what tells you
    // how big a room is when you are standing in it.
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = 72;
      camera.updateProjectionMatrix();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, plan]);

  useFrame((_, delta) => {
    if (!enabled) return;

    // Fixed steps, with the remainder carried into the next frame. Capped so a
    // long stall - a tab in the background - cannot run hundreds of steps at
    // once when it resumes.
    carry.current = Math.min(carry.current + delta, 0.25);

    while (carry.current >= STEP) {
      carry.current -= STEP;

      const k = keys.current;
      const forward = (k.w || k.arrowup ? 1 : 0) - (k.s || k.arrowdown ? 1 : 0);
      const strafe = (k.d || k.arrowright ? 1 : 0) - (k.a || k.arrowleft ? 1 : 0);
      const speed = k.shift ? RUN_SPEED : WALK_SPEED;

      // Heading straight from the camera, so you walk where you look.
      const facing = new THREE.Vector3();
      camera.getWorldDirection(facing);
      const yaw = Math.atan2(facing.x, facing.z);

      const target = new THREE.Vector2(
        (Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * speed,
        (Math.cos(yaw) * forward - Math.sin(yaw) * strafe) * speed,
      );
      if (forward === 0 && strafe === 0) target.set(0, 0);

      velocity.current.lerp(target, 1 - Math.exp(-ACCEL * STEP));

      const here = state.current;
      const walls = colliders.get(here.level) ?? [];
      const [nx, ny] = moveWithSliding(
        walls,
        [here.x, here.y],
        velocity.current.x * STEP,
        velocity.current.y * STEP,
      );

      const ground = groundAt(plan, here.level, nx, ny);
      if (ground.level !== here.level) onLevelChange(ground.level);

      state.current = { x: nx, y: ny, level: ground.level, yaw };
      eye.current += (ground.height + EYE_HEIGHT - eye.current) * (1 - Math.exp(-EYE_EASE * STEP));
    }

    camera.position.set(state.current.x, eye.current, state.current.y);

    // A readout for tests and for anyone debugging where the walker thinks it
    // is. Writing to a global rather than React state deliberately: this runs
    // at 60Hz and must not cost a render.
    (window as unknown as { __walk?: unknown }).__walk = {
      x: state.current.x,
      y: state.current.y,
      level: state.current.level,
      eye: eye.current,
      camera: [camera.position.x, camera.position.y, camera.position.z],
    };
  });

  if (!enabled) return null;
  return <PointerLockControls makeDefault selector="[data-walk-lock]" />;
}
