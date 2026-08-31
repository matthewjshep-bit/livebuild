"use client";

import { useFrame, useThree } from "@react-three/fiber";

import { usePrefersReducedMotion } from "@/lib/a11y/reduced-motion";
import { useEffect, useRef } from "react";
import * as THREE from "three";

import { frameRoom } from "@/lib/model/focus";
import { levelsOf, planBounds } from "@/lib/plan/geometry";
import type { Plan } from "@/lib/schema";

export type ViewState =
  | { mode: "dollhouse" }
  /** First person, on foot. The walker owns the camera in this mode. */
  | { mode: "walk" }
  /** The architectural plan, which is a drawing rather than a camera. */
  | { mode: "plan" };

const TRANSITION_MS = 850;

const UP = new THREE.Vector3(0, 1, 0);

const DOLLHOUSE_FOV = 55;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export type Orbit = { azimuth: number; elevation: number; distance: number };

/** Centre of the plan, which the dollhouse camera orbits around. */
export function planCenter(plan: Plan): THREE.Vector3 {
  const { min, max } = planBounds(plan);
  const levels = levelsOf(plan);
  // Orbit the middle of the stack, not the ground floor, so an upstairs is not
  // permanently above the frame.
  const midHeight = levels.length > 1 ? (levels.length - 1) * 1.5 : 0;
  return new THREE.Vector3((min[0] + max[0]) / 2, midHeight, (min[1] + max[1]) / 2);
}

export function defaultOrbit(plan: Plan): Orbit {
  const { min, max } = planBounds(plan);
  // A taller house needs more distance, or the upper storeys leave the frame.
  const storeys = Math.max(levelsOf(plan).length, 1);
  const span = Math.max(max[0] - min[0], max[1] - min[1], 4) * (1 + (storeys - 1) * 0.28);
  // Roughly 40 degrees up: high enough to read the layout at a glance, shallow
  // enough that the walls still convey height.
  return { azimuth: 0, elevation: 0.66, distance: span * 1.35 };
}

function orbitPosition(center: THREE.Vector3, orbit: Orbit): THREE.Vector3 {
  const horizontal = Math.cos(orbit.elevation) * orbit.distance;
  return new THREE.Vector3(
    center.x + Math.sin(orbit.azimuth) * horizontal,
    center.y + Math.sin(orbit.elevation) * orbit.distance,
    center.z + Math.cos(orbit.azimuth) * horizontal,
  );
}

/**
 * Drives the orbiting camera, and the eased flight between the things it frames.
 *
 * There used to be a second mode here, which set the camera down at a
 * photograph's own viewpoint and matched its field of view so the picture
 * covered the screen. Nothing stands at a photograph any more - the house is
 * built, and you walk through the building rather than between the pictures of
 * it - so what is left is the dollhouse and the flight between rooms.
 */
export function CameraRig({
  plan,
  view,
  paused = false,
  explode = 0,
  focusRoomId = null,
}: {
  plan: Plan;
  view: ViewState;
  /**
   * One room being looked at on its own, or null for the whole house.
   *
   * Deliberately not part of `ViewState`. Focus is orthogonal to which mode you
   * are in - you can be focused on a room and then walk into it - and folding it
   * into the union would mean revisiting every `mode ===` test in this file and
   * the viewer above it.
   */
  focusRoomId?: string | null;
  /** True while something else is driving the camera. */
  paused?: boolean;
  /** How far the house is pulled apart, so the camera can keep it in frame. */
  explode?: number;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  const orbit = useRef<Orbit>(defaultOrbit(plan));
  const dragging = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });

  // Pose we are animating away from, captured at the moment the view changed.
  const from = useRef({
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
  });
  const startedAt = useRef(0);
  const previousView = useRef<ViewState | null>(null);
  const previousFocus = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const previous = previousView.current;
    // Focusing a room is a move like any other, and has to restart the eased
    // flight or the camera arrives instantly. It cannot ride on the settle-lerp
    // below instead: that copies the quaternion rather than slerping it, so the
    // camera would snap round to face the new room while still gliding towards
    // it, and slerping there would put lag into every orbit drag.
    const focusChanged =
      previousFocus.current !== undefined && previousFocus.current !== focusRoomId;
    const changed = !previous || previous.mode !== view.mode || focusChanged;

    if (focusChanged) {
      // Distance and height come from the room; which side you are standing on
      // is left alone, so the camera closes in from wherever you were rather
      // than swinging round the house first.
      const room = focusRoomId ? plan.rooms.find((r) => r.id === focusRoomId) : null;
      const framed = room ? frameRoom(plan, room) : defaultOrbit(plan);
      orbit.current.distance = framed.distance;
      orbit.current.elevation = framed.elevation;
    }
    previousFocus.current = focusRoomId;

    if (changed) {
      from.current.position.copy(camera.position);
      from.current.quaternion.copy(camera.quaternion);
      startedAt.current = performance.now();
    }
    previousView.current = view;
  }, [view, camera, focusRoomId, plan]);

  useEffect(() => {
    const element = gl.domElement;

    const onPointerDown = (e: PointerEvent) => {
      // Orbit and pointer-lock look would both be steering at once otherwise.
      if (view.mode !== "dollhouse") return;
      dragging.current = true;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      element.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (view.mode !== "dollhouse" || !dragging.current) return;
      const dx = e.clientX - lastPointer.current.x;
      const dy = e.clientY - lastPointer.current.y;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      orbit.current.azimuth -= dx * 0.006;
      orbit.current.elevation = THREE.MathUtils.clamp(
        orbit.current.elevation + dy * 0.005,
        0.12,
        1.45,
      );
    };

    const stop = (e: PointerEvent) => {
      dragging.current = false;
      if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId);
    };

    const onWheel = (e: WheelEvent) => {
      if (view.mode !== "dollhouse") return;
      e.preventDefault();
      orbit.current.distance = THREE.MathUtils.clamp(
        orbit.current.distance * (1 + e.deltaY * 0.0012),
        3,
        80,
      );
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", stop);
    element.addEventListener("pointercancel", stop);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", stop);
      element.removeEventListener("pointercancel", stop);
    };
  }, [gl, view.mode]);

  const scratch = useRef({
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    lookAt: new THREE.Matrix4(),
  }).current;

  const applyFov = (fov: number) => {
    const perspective = camera as THREE.PerspectiveCamera;
    if (Math.abs(perspective.fov - fov) < 0.01) return;
    perspective.fov = fov;
    perspective.updateProjectionMatrix();
  };

  // The camera is moved from JavaScript every frame, so the reduced-motion
  // rule in `globals.css` never reaches it. This is also the motion that
  // matters most: an 850ms flight across a house is a large field movement,
  // repeated on every click, and it is the classic vestibular trigger. Asked
  // for less motion, the camera cuts instead - it still arrives in the same
  // place looking the same way, it simply does not travel there.
  const reducedMotion = usePrefersReducedMotion();

  useFrame(() => {
    // Walking hands the camera to WalkControls entirely, and a scripted tour
    // takes it the same way. Two things writing camera.position on the same
    // frame is a fight the user sees as jitter.
    if (view.mode !== "dollhouse" || paused) return;

    const elapsed = performance.now() - startedAt.current;
    const raw = reducedMotion ? 1 : THREE.MathUtils.clamp(elapsed / TRANSITION_MS, 0, 1);
    const t = easeInOutCubic(raw);

    const room = focusRoomId ? plan.rooms.find((r) => r.id === focusRoomId) : null;
    const center = room ? new THREE.Vector3(...frameRoom(plan, room).center) : planCenter(plan);
    // Pulling the house apart makes it bigger, so the camera has to give
    // ground or the pieces simply leave the frame - which is what happened
    // the first time, and looks like the rooms have been deleted.
    const framed = {
      ...orbit.current,
      distance: orbit.current.distance * (1 + explode * 1.1),
    };
    scratch.position.copy(orbitPosition(center, framed));
    scratch.lookAt.lookAt(scratch.position, center, UP);
    scratch.quaternion.setFromRotationMatrix(scratch.lookAt);
    applyFov(DOLLHOUSE_FOV);

    // A readout for the browser suite, alongside WalkControls' `__walk`. Where
    // the camera ended up cannot be seen from outside the canvas, and a
    // screenshot cannot tell "flew to the kitchen" from "happened to be
    // pointing that way".
    (window as unknown as { __camera?: unknown }).__camera = {
      focusRoomId: focusRoomId ?? null,
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: [center.x, center.y, center.z],
    };

    if (raw < 1) {
      camera.position.lerpVectors(from.current.position, scratch.position, t);
      camera.quaternion.slerpQuaternions(from.current.quaternion, scratch.quaternion, t);
    } else {
      camera.position.lerp(scratch.position, 0.18);
      camera.quaternion.copy(scratch.quaternion);
    }
    camera.updateMatrixWorld();
  });

  return null;
}
