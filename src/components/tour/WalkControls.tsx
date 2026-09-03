"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import {
  EYE_HEIGHT,
  type Collider,
  blocked,
  collidersFor,
  groundAt,
  moveWithSliding,
  roomAt,
  startingPoint,
} from "@/lib/model/collide";
import { DRAG_SENSITIVITY, LOOK_DAMPING, type Look, damped, headingVector, turnBy } from "@/lib/model/look";
import { routeTo } from "@/lib/model/route";
import { MAX_STEP } from "@/lib/model/stairs";
import type { Plan, Vec2 } from "@/lib/schema";

/**
 * On foot: click where you want to stand, drag to look around.
 *
 * The first walker took its heading from a pointer lock. Without the lock -
 * which a browser may refuse, a touch screen never has, and Escape gives
 * back - the arrow keys could strafe but never turn, and there was no way
 * to say "over there". This one owns its own heading. A drag anywhere on
 * the canvas turns the head, with a little momentum after letting go; a
 * click - a press that did not drag - is a place to walk to, reached through
 * the doorways at walking pace; the keys still work, and Q and E turn
 * without the mouse. Nothing here can be got stuck in.
 */

const WALK_SPEED = 1.5; // m/s, an unhurried indoor pace
const RUN_SPEED = 3.0;
const ACCEL = 11;
const STEP = 1 / 120;
const EYE_EASE = 7;
/** Radians per second, holding Q or E. */
const TURN_RATE = 1.8;
/** A press that moved less than this is a click, not a drag. */
const CLICK_PIXELS = 6;
/** Close enough to a waypoint to count as reached. */
const ARRIVE_M = 0.15;

export type WalkState = {
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
  start = null,
}: {
  plan: Plan;
  level: number;
  onLevelChange: (level: number) => void;
  state: React.MutableRefObject<WalkState>;
  start?: { position: Vec2; level: number; yaw: number } | null;
  enabled: boolean;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const keys = useRef<Record<string, boolean>>({});
  const velocity = useRef(new THREE.Vector2());
  const carry = useRef(0);
  const eye = useRef(0);
  // Where the feet actually are. The eye is eased toward its target for the
  // look of it, and lags - using it to decide which surface you are on would
  // pick the wrong one halfway up a flight.
  const foot = useRef(0);
  const look = useRef<Look>({ yaw: 0, pitch: 0 });
  const lookVelocity = useRef<Look>({ yaw: 0, pitch: 0 });
  const drag = useRef<{ id: number; x: number; y: number; moved: number; lastAt: number; vx: number; vy: number } | null>(null);
  /** Where a click asked to walk to: the doorways on the way, then the spot. */
  const glide = useRef<{ waypoints: Vec2[]; index: number; since: number; at: Vec2 } | null>(null);

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
      // A key cancels a click's walk: the person has taken over.
      glide.current = null;
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

  /**
   * The pointer: a drag looks, a click walks.
   *
   * On the canvas in the capture phase, ahead of the renderer's own
   * handlers, and stopped there: on foot a click on a cabinet is a place to
   * walk to, not a fitting to price. Pointer events cover a finger as well
   * as a mouse, so a touch screen drags and taps the same way.
   */
  useEffect(() => {
    if (!enabled) return;
    const element = gl.domElement;
    element.style.cursor = "grab";

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      e.stopImmediatePropagation();
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0, lastAt: performance.now(), vx: 0, vy: 0 };
      lookVelocity.current = { yaw: 0, pitch: 0 };
      element.setPointerCapture(e.pointerId);
      element.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      e.stopImmediatePropagation();
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.moved += Math.hypot(dx, dy);
      d.x = e.clientX;
      d.y = e.clientY;
      const now = performance.now();
      const dt = Math.max(1, now - d.lastAt) / 1000;
      d.lastAt = now;
      // Pixels per second, for the momentum after letting go.
      d.vx = dx / dt;
      d.vy = dy / dt;
      look.current = turnBy(look.current, dx, dy);
      // A drag cancels a click's walk as a key does.
      if (d.moved > CLICK_PIXELS) glide.current = null;
    };
    const onUp = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      e.stopImmediatePropagation();
      drag.current = null;
      element.style.cursor = "grab";
      if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId);
      if (d.moved > CLICK_PIXELS) {
        // Let the turn run on a little.
        lookVelocity.current = { yaw: -d.vx * DRAG_SENSITIVITY, pitch: -d.vy * DRAG_SENSITIVITY };
        return;
      }
      // A click: where on the floor was it?
      const rect = element.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), -foot.current);
      const hit = new THREE.Vector3();
      if (!ray.ray.intersectPlane(floor, hit)) return;
      const here = state.current;
      const to: Vec2 = [hit.x, hit.z];
      // Only a spot in a room, with room to stand: a click on a wall or out
      // of the house walks nowhere.
      if (!roomAt(plan, here.level, to[0], to[1])) return;
      if (blocked(colliders.get(here.level) ?? [], to[0], to[1])) return;
      const waypoints = routeTo(plan, here.level, [here.x, here.y], to);
      if (!waypoints) return;
      glide.current = { waypoints, index: 0, since: performance.now(), at: [here.x, here.y] };
    };
    const onCancel = (e: PointerEvent) => {
      if (drag.current?.id === e.pointerId) drag.current = null;
      element.style.cursor = "grab";
    };
    element.addEventListener("pointerdown", onDown, true);
    element.addEventListener("pointermove", onMove, true);
    element.addEventListener("pointerup", onUp, true);
    element.addEventListener("pointercancel", onCancel, true);
    return () => {
      element.removeEventListener("pointerdown", onDown, true);
      element.removeEventListener("pointermove", onMove, true);
      element.removeEventListener("pointerup", onUp, true);
      element.removeEventListener("pointercancel", onCancel, true);
      element.style.cursor = "";
    };
  }, [enabled, gl, camera, plan, colliders, state]);

  // Drop the walker into the house when the mode opens.
  useEffect(() => {
    if (!enabled) return;
    const at = start ?? { position: startingPoint(plan, level), level, yaw: null };
    const [sx, sy] = at.position;
    const ground = groundAt(plan, at.level, sx, sy);
    state.current = { x: sx, y: sy, level: at.level, yaw: 0 };
    eye.current = ground.height + EYE_HEIGHT;
    foot.current = ground.height;
    velocity.current.set(0, 0);
    glide.current = null;
    camera.position.set(sx, eye.current, sy);
    // Dropping upstairs has to tell the viewer, or it goes on drawing the floor
    // below and the walker stands on geometry that is not there.
    if (at.level !== level) onLevelChange(at.level);
    // Level, facing the way the room was entered - or whichever way the orbit
    // was left, walking into a house from nowhere in particular. The orbit's
    // facing is read as a direction, not as `rotation.y`: an orbit camera's
    // Euler order is not the walker's, and the number is not a yaw.
    const facing = new THREE.Vector3();
    camera.getWorldDirection(facing);
    look.current = { yaw: at.yaw ?? Math.atan2(facing.x, facing.z), pitch: 0 };
    lookVelocity.current = { yaw: 0, pitch: 0 };
    camera.rotation.set(0, look.current.yaw, 0, "YXZ");
    camera.up.set(0, 1, 0);
    // Wider than the dollhouse uses. A 55-degree lens indoors feels like
    // looking down a tube - rooms read as narrower than they are and you
    // cannot see the floor near your feet, which is most of what tells you
    // how big a room is when you are standing in it.
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = 72;
      camera.updateProjectionMatrix();
    }
    // `level` stays out on purpose - climbing the stairs must not re-drop you -
    // but `start` is in, because asking for a different room is exactly a
    // request to be moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, plan, start]);

  useFrame((_, delta) => {
    if (!enabled) return;

    // The head: a released drag runs on and dies away; Q and E turn.
    const k = keys.current;
    const turn = (k.q ? 1 : 0) - (k.e ? 1 : 0);
    const dt = Math.min(delta, 0.25);
    look.current = {
      yaw: look.current.yaw + lookVelocity.current.yaw * dt + turn * TURN_RATE * dt,
      pitch: look.current.pitch,
    };
    look.current = turnBy(look.current, 0, -lookVelocity.current.pitch * dt / DRAG_SENSITIVITY);
    lookVelocity.current = {
      yaw: damped(lookVelocity.current.yaw, dt, LOOK_DAMPING),
      pitch: damped(lookVelocity.current.pitch, dt, LOOK_DAMPING),
    };

    // Fixed steps, with the remainder carried into the next frame. Capped so a
    // long stall - a tab in the background - cannot run hundreds of steps at
    // once when it resumes.
    carry.current = Math.min(carry.current + delta, 0.25);
    while (carry.current >= STEP) {
      carry.current -= STEP;
      const forward = (k.w || k.arrowup ? 1 : 0) - (k.s || k.arrowdown ? 1 : 0);
      const strafe = (k.d || k.arrowright ? 1 : 0) - (k.a || k.arrowleft ? 1 : 0);
      const speed = k.shift ? RUN_SPEED : WALK_SPEED;
      const yaw = look.current.yaw;
      const [hx, hy] = headingVector(yaw);
      const here = state.current;
      const target = new THREE.Vector2(
        (hx * forward + hy * strafe) * speed,
        (hy * forward - hx * strafe) * speed,
      );

      // A click's walk: toward the next doorway, then the spot.
      const g = glide.current;
      if (g && forward === 0 && strafe === 0) {
        const goal = g.waypoints[g.index];
        const dx = goal[0] - here.x;
        const dy = goal[1] - here.y;
        const far = Math.hypot(dx, dy);
        if (far < ARRIVE_M) {
          g.index += 1;
          if (g.index >= g.waypoints.length) glide.current = null;
        } else {
          target.set((dx / far) * WALK_SPEED, (dy / far) * WALK_SPEED);
          // Stuck - against something the route did not know about - for
          // half a second is stuck; stop rather than shove.
          const now = performance.now();
          if (now - g.since > 500) {
            if (Math.hypot(here.x - g.at[0], here.y - g.at[1]) < 0.01) glide.current = null;
            g.since = now;
            g.at = [here.x, here.y];
          }
        }
      }
      if (target.lengthSq() === 0) target.set(0, 0);
      velocity.current.lerp(target, 1 - Math.exp(-ACCEL * STEP));

      const walls = colliders.get(here.level) ?? [];
      let [nx, ny] = moveWithSliding(walls, [here.x, here.y], velocity.current.x * STEP, velocity.current.y * STEP);
      let ground = groundAt(plan, here.level, nx, ny, foot.current);
      // Refuse a step no person could take - off a flight into the stairwell,
      // out of an upstairs door onto the void - but try each direction on its
      // own first, so a threshold that is fine to cross straight on does not
      // stop a diagonal step dead with no sign of why.
      if (Math.abs(ground.height - foot.current) > MAX_STEP) {
        const alongX: Vec2 = [nx, here.y];
        const alongY: Vec2 = [here.x, ny];
        const gx = groundAt(plan, here.level, alongX[0], alongX[1], foot.current);
        const gy = groundAt(plan, here.level, alongY[0], alongY[1], foot.current);
        if (Math.abs(gx.height - foot.current) <= MAX_STEP) {
          [nx, ny] = alongX;
          ground = gx;
        } else if (Math.abs(gy.height - foot.current) <= MAX_STEP) {
          [nx, ny] = alongY;
          ground = gy;
        } else {
          velocity.current.set(0, 0);
          glide.current = null;
          continue;
        }
      }
      foot.current = ground.height;
      if (ground.level !== here.level) onLevelChange(ground.level);
      state.current = { x: nx, y: ny, level: ground.level, yaw };
      eye.current += (ground.height + EYE_HEIGHT - eye.current) * (1 - Math.exp(-EYE_EASE * STEP));
    }

    camera.position.set(state.current.x, eye.current, state.current.y);
    camera.rotation.set(look.current.pitch, look.current.yaw, 0, "YXZ");

    // A readout for tests and for anyone debugging where the walker thinks it
    // is. Writing to a global rather than React state deliberately: this runs
    // at 60Hz and must not cost a render.
    (window as unknown as { __walk?: unknown }).__walk = {
      x: state.current.x,
      y: state.current.y,
      level: state.current.level,
      eye: eye.current,
      camera: [camera.position.x, camera.position.y, camera.position.z],
      yaw: look.current.yaw,
      pitch: look.current.pitch,
      gliding: glide.current !== null,
    };
  });

  return null;
}
