"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";

import { levelsOf, nodeBaseY, planBounds, planToWorld } from "@/lib/plan/geometry";
import type { Plan, TourNode } from "@/lib/schema";

export type ViewState =
  | { mode: "dollhouse" }
  | { mode: "node"; nodeId: string }
  /** First person, on foot. The walker owns the camera in this mode. */
  | { mode: "walk" };

const TRANSITION_MS = 850;

const UP = new THREE.Vector3(0, 1, 0);

const DOLLHOUSE_FOV = 55;

/**
 * Vertical FOV at which the photo covers the viewport rather than fitting
 * inside it.
 *
 * A shell only holds colour across the angle the lens actually captured, so if
 * the camera is any wider you see past its edge to the empty scene behind. The
 * fix is to crop instead: match whichever axis is binding and let the other
 * overflow, exactly like CSS `object-fit: cover`.
 */
function coveringFovDeg(photoHFovDeg: number, photoAspect: number, viewAspect: number): number {
  const tanHalfH = Math.tan((photoHFovDeg * Math.PI) / 180 / 2);
  const limiting = viewAspect >= photoAspect ? viewAspect : photoAspect;
  // The 0.985 keeps the very edge of the shell just off-screen, where its
  // ragged boundary would otherwise be visible against the background.
  return (2 * Math.atan((tanHalfH / limiting) * 0.985) * 180) / Math.PI;
}

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

function nodeQuaternion(node: TourNode, yaw: number, pitch: number): THREE.Quaternion {
  const euler = new THREE.Euler(
    pitch,
    // The camera looks down -Z while headings are measured off +Z, so the
    // node's bearing needs half a turn added to become a camera rotation.
    (node.heading * Math.PI) / 180 + Math.PI + yaw,
    0,
    "YXZ",
  );
  return new THREE.Quaternion().setFromEuler(euler);
}

/**
 * Drives the camera for both modes and the animation between them.
 *
 * Two things make this read as movement through a building rather than a
 * slideshow. First, a move between nodes translates the camera the real metric
 * distance between them, so the shells parallax past each other exactly as the
 * geometry says they should. Second, look direction is preserved across a move:
 * you keep facing the way you were facing, which is what makes stepping forward
 * feel like walking rather than cutting to another shot.
 */
export type TransitionState = {
  fromNodeId: string | null;
  toNodeId: string | null;
  /** 0 at the start of a move, 1 once settled. */
  t: number;
};

export function CameraRig({
  plan,
  nodes,
  view,
  transition,
  aspects,
}: {
  plan: Plan;
  nodes: TourNode[];
  view: ViewState;
  /** Written every frame. A ref, not state, so a move costs no re-renders. */
  transition: React.MutableRefObject<TransitionState>;
  /** Node id to true photo aspect, filled in as textures decode. */
  aspects: React.MutableRefObject<Map<string, number>>;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);

  const yaw = useRef(0);
  const pitch = useRef(0);
  const orbit = useRef<Orbit>(defaultOrbit(plan));
  const parallax = useRef(new THREE.Vector2());
  const dragging = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });

  // Pose we are animating away from, captured at the moment the view changed.
  const from = useRef({
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    nodeId: null as string | null,
  });
  const startedAt = useRef(0);
  const previousView = useRef<ViewState | null>(null);

  const byId = useRef(new Map<string, TourNode>());
  byId.current = new Map(nodes.map((n) => [n.id, n]));

  useEffect(() => {
    const previous = previousView.current;
    const changed =
      !previous ||
      previous.mode !== view.mode ||
      (previous.mode === "node" && view.mode === "node" && previous.nodeId !== view.nodeId);

    if (changed) {
      from.current.position.copy(camera.position);
      from.current.quaternion.copy(camera.quaternion);
      from.current.nodeId = previous?.mode === "node" ? previous.nodeId : null;
      startedAt.current = performance.now();

      // Entering a node from the dollhouse starts you square with the photo;
      // moving between nodes keeps whatever direction you were already facing.
      if (view.mode === "node" && previous?.mode !== "node") {
        yaw.current = 0;
        pitch.current = 0;
      }
    }
    previousView.current = view;
  }, [view, camera]);

  useEffect(() => {
    const element = gl.domElement;

    const onPointerDown = (e: PointerEvent) => {
      // Orbit and pointer-lock look would both be steering at once otherwise.
      if (view.mode === "walk") return;
      dragging.current = true;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      element.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (view.mode === "walk") return;
      const rect = element.getBoundingClientRect();

      if (view.mode === "dollhouse") {
        if (!dragging.current) return;
        const dx = e.clientX - lastPointer.current.x;
        const dy = e.clientY - lastPointer.current.y;
        lastPointer.current = { x: e.clientX, y: e.clientY };
        orbit.current.azimuth -= dx * 0.006;
        orbit.current.elevation = THREE.MathUtils.clamp(
          orbit.current.elevation + dy * 0.005,
          0.12,
          1.45,
        );
        return;
      }

      if (dragging.current) {
        const dx = e.clientX - lastPointer.current.x;
        const dy = e.clientY - lastPointer.current.y;
        lastPointer.current = { x: e.clientX, y: e.clientY };
        yaw.current -= dx * 0.0032;
        pitch.current = THREE.MathUtils.clamp(
          pitch.current - dy * 0.0032,
          -Math.PI / 2.4,
          Math.PI / 2.4,
        );
        return;
      }

      // Not dragging: a gentle lean toward the pointer. This is where the 2.5D
      // shell earns its keep - without any camera translation the photo would
      // be indistinguishable from a flat panorama.
      parallax.current.set(
        ((e.clientX - rect.left) / rect.width - 0.5) * 2,
        ((e.clientY - rect.top) / rect.height - 0.5) * 2,
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
    right: new THREE.Vector3(),
    up: new THREE.Vector3(),
    lookAt: new THREE.Matrix4(),
  }).current;

  const applyFov = (fov: number) => {
    const perspective = camera as THREE.PerspectiveCamera;
    if (Math.abs(perspective.fov - fov) < 0.01) return;
    perspective.fov = fov;
    perspective.updateProjectionMatrix();
  };

  useFrame(() => {
    // Walking hands the camera to WalkControls entirely. Two things writing
    // camera.position on the same frame is a fight the user sees as jitter.
    if (view.mode === "walk") return;

    const elapsed = performance.now() - startedAt.current;
    const raw = THREE.MathUtils.clamp(elapsed / TRANSITION_MS, 0, 1);
    const t = easeInOutCubic(raw);

    if (view.mode === "dollhouse") {
      const center = planCenter(plan);
      scratch.position.copy(orbitPosition(center, orbit.current));
      scratch.lookAt.lookAt(scratch.position, center, UP);
      scratch.quaternion.setFromRotationMatrix(scratch.lookAt);
      applyFov(DOLLHOUSE_FOV);
      transition.current = { fromNodeId: from.current.nodeId, toNodeId: null, t: raw };
    } else {
      const node = byId.current.get(view.nodeId);
      if (!node) return;

      applyFov(
        coveringFovDeg(
          node.fovDeg,
          aspects.current.get(node.id) ?? 1.5,
          size.width / Math.max(size.height, 1),
        ),
      );

      const [x, y, z] = planToWorld(node.position, nodeBaseY(plan, node) + node.eyeHeight);
      scratch.position.set(x, y, z);
      scratch.quaternion.copy(nodeQuaternion(node, yaw.current, pitch.current));

      // Lean, applied in the camera's own frame and clamped to the budget the
      // depth pass derived for this photo. Exceeding it is what makes a shell
      // visibly tear, so the limit is data, not taste.
      const budget = node.parallaxBudget;
      if (budget > 0 && raw >= 1) {
        scratch.right.set(1, 0, 0).applyQuaternion(scratch.quaternion);
        scratch.up.set(0, 1, 0).applyQuaternion(scratch.quaternion);
        scratch.position
          .addScaledVector(scratch.right, parallax.current.x * budget)
          .addScaledVector(scratch.up, -parallax.current.y * budget * 0.6);
      }

      transition.current = { fromNodeId: from.current.nodeId, toNodeId: view.nodeId, t: raw };
    }

    if (raw < 1) {
      camera.position.lerpVectors(from.current.position, scratch.position, t);
      camera.quaternion.slerpQuaternions(from.current.quaternion, scratch.quaternion, t);
    } else {
      // Easing the lean rather than snapping keeps the pointer from feeling
      // like it is dragging the whole room around.
      camera.position.lerp(scratch.position, 0.18);
      camera.quaternion.copy(scratch.quaternion);
    }
    camera.updateMatrixWorld();
  });

  return null;
}
