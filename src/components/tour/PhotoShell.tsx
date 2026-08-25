"use client";

import { useFrame, useLoader } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { planToWorld } from "@/lib/plan/geometry";
import {
  SHELL_SEGMENTS,
  configureDepthTexture,
  configurePhotoTexture,
  createShellMaterial,
} from "@/lib/render/depth-shell";
import type { TourNode } from "@/lib/schema";

/**
 * One posed photo, rendered as a depth-displaced shell at its node.
 *
 * The plane's UV grid is only a parameter domain - every vertex is repositioned
 * in the vertex shader onto the ray it was captured along. So the mesh needs no
 * scale of its own; it just has to sit at the node's position and carry the
 * node's heading, and the geometry falls out of the depth map.
 */
export function PhotoShell({
  node,
  getOpacity,
  onAspect,
  baseY = 0,
}: {
  node: TourNode;
  /**
   * Read once per frame rather than passed as a prop: a cross-fade changes
   * every frame, and re-rendering React at 60fps to move one float would cost
   * more than the render itself.
   */
  getOpacity: () => number;
  /** The photo's true aspect, known only once decoded. */
  onAspect?: (nodeId: string, aspect: number) => void;
  /** Floor height of the storey this node stands on. */
  baseY?: number;
}) {
  const photo = useLoader(THREE.TextureLoader, node.photo);
  const depth = useLoader(THREE.TextureLoader, node.depth ?? node.photo);
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  const geometry = useMemo(
    () => new THREE.PlaneGeometry(1, 1, SHELL_SEGMENTS, SHELL_SEGMENTS),
    [],
  );

  const material = useMemo(() => {
    configurePhotoTexture(photo);
    configureDepthTexture(depth);
    const aspect = (photo.image?.width ?? 3) / (photo.image?.height ?? 2);
    onAspect?.(node.id, aspect);
    return createShellMaterial({ photo, depth, fovDeg: node.fovDeg, aspect });
  }, [photo, depth, node.fovDeg, node.id, onAspect]);

  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);

  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(() => {
    const opacity = getOpacity();
    material.uniforms.uOpacity.value = opacity;
    // Skipping the draw entirely once a shell is invisible matters: several may
    // be resident at once so neighbours are warm before you step to them.
    if (meshRef.current) meshRef.current.visible = opacity > 0.002;
  });

  const position = planToWorld(node.position, baseY + node.eyeHeight);

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      position={position}
      // Heading is a compass bearing and the shell's forward axis is +Z, which
      // planToWorld maps from plan +y - so the rotation is the heading itself.
      rotation={[0, (node.heading * Math.PI) / 180, 0]}
      frustumCulled={false}
    >
      <primitive object={material} ref={materialRef} attach="material" />
    </mesh>
  );
}

/**
 * Fallback for a node with no depth map: the photo on a flat billboard, sized
 * so it subtends the same angle the shell would. This is what keeps a tour
 * usable before any GPU has touched it, and it is also the whole product if the
 * Phase 0 spike says monocular depth cannot handle the photos.
 */
export function FlatShell({
  node,
  getOpacity,
  distance = 4,
  baseY = 0,
}: {
  node: TourNode;
  getOpacity: () => number;
  distance?: number;
  baseY?: number;
}) {
  const photo = useLoader(THREE.TextureLoader, node.photo);
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame(() => {
    const opacity = getOpacity();
    if (materialRef.current) materialRef.current.opacity = opacity;
    if (meshRef.current) meshRef.current.visible = opacity > 0.002;
  });

  const size = useMemo(() => {
    configurePhotoTexture(photo);
    const aspect = (photo.image?.width ?? 3) / (photo.image?.height ?? 2);
    const width = 2 * distance * Math.tan((node.fovDeg * Math.PI) / 180 / 2);
    return [width, width / aspect] as const;
  }, [photo, node.fovDeg, distance]);

  const origin = planToWorld(node.position, baseY + node.eyeHeight);
  const heading = (node.heading * Math.PI) / 180;

  return (
    <mesh
      ref={meshRef}
      position={[
        origin[0] + Math.sin(heading) * distance,
        origin[1],
        origin[2] + Math.cos(heading) * distance,
      ]}
      // Same convention as the shell: +Z is forward, so the plane keeps the
      // node's heading. Turning it to face the viewer instead would mirror the
      // photo, which is why this renders double-sided rather than rotating.
      rotation={[0, heading, 0]}
    >
      <planeGeometry args={[size[0], size[1]]} />
      <meshBasicMaterial
        ref={materialRef}
        map={photo}
        transparent
        side={THREE.DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}
