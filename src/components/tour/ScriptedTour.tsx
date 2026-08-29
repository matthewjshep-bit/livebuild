"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";

import type { Beat } from "@/lib/model/tour-script";

/**
 * Fly the camera through a scripted tour.
 *
 * The camera arcs about the target rather than moving in a straight line to it.
 * A straight interpolation between two viewpoints cuts the corner, and in a
 * building the corner it cuts is a wall - you pass through the house rather
 * than around it, which reads as a glitch even to someone who could not say
 * what went wrong.
 */
export function ScriptedTour({
  beats,
  running,
  onBeat,
  onFinish,
}: {
  beats: Beat[];
  running: boolean;
  onBeat: (caption: string) => void;
  onFinish: () => void;
}) {
  const camera = useThree((s) => s.camera);
  const index = useRef(0);
  const startedAt = useRef(0);
  const origin = useRef(new THREE.Vector3());
  const originTarget = useRef(new THREE.Vector3());

  useEffect(() => {
    if (!running || beats.length === 0) return;
    index.current = 0;
    startedAt.current = performance.now();
    origin.current.copy(camera.position);
    // Where the camera was pointing, taken a few metres ahead of it so the
    // first move eases out of the current view rather than snapping.
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    originTarget.current.copy(camera.position).addScaledVector(forward, 8);
    onBeat(beats[0].caption);
  }, [running, beats, camera, onBeat]);

  useFrame(() => {
    if (!running || beats.length === 0) return;

    const beat = beats[index.current];
    if (!beat) return;

    const elapsed = performance.now() - startedAt.current;
    const t = Math.min(1, elapsed / beat.ms);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    const previous = index.current === 0 ? null : beats[index.current - 1];
    const fromPos = previous ? new THREE.Vector3(...previous.from) : origin.current;
    const fromAt = previous ? new THREE.Vector3(...previous.at) : originTarget.current;
    const toPos = new THREE.Vector3(...beat.from);
    const toAt = new THREE.Vector3(...beat.at);

    // Arc about the target: interpolate the angle and the radius separately, so
    // the path bows outward instead of cutting through the building.
    const target = fromAt.clone().lerp(toAt, eased);
    const a = fromPos.clone().sub(fromAt);
    const b = toPos.clone().sub(toAt);
    const angleA = Math.atan2(a.z, a.x);
    let delta = Math.atan2(b.z, b.x) - angleA;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    const radius = THREE.MathUtils.lerp(Math.hypot(a.x, a.z), Math.hypot(b.x, b.z), eased);
    const angle = angleA + delta * eased;
    const height = THREE.MathUtils.lerp(a.y, b.y, eased);

    camera.position.set(
      target.x + Math.cos(angle) * radius,
      target.y + height,
      target.z + Math.sin(angle) * radius,
    );
    camera.lookAt(target);

    if (t >= 1) {
      index.current += 1;
      startedAt.current = performance.now();
      const next = beats[index.current];
      if (next) onBeat(next.caption);
      else onFinish();
    }
  });

  return null;
}

/** Media types worth trying, best first. */
const FORMATS = [
  "video/mp4;codecs=avc1.4d002a",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm",
];

export function supportedFormat(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return FORMATS.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

/**
 * Record the canvas itself, rather than the screen.
 *
 * `captureStream` on the canvas gives an exact-size, cursor-free file with no
 * permission prompt and nothing of the rest of the page in it.
 *
 * The cost, and it is worth stating plainly: the stream carries only what WebGL
 * draws. The captions are HTML sitting over the canvas, so they appear on
 * screen while the tour runs and are absent from the file. Burning them in
 * would mean rendering text inside the scene, which is a larger job than the
 * tour itself.
 */
export function recordCanvas(
  canvas: HTMLCanvasElement,
  ms: number,
  onDone: (blob: Blob) => void,
): () => void {
  const type = supportedFormat();
  if (!type) {
    onDone(new Blob());
    return () => {};
  }

  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
  const chunks: BlobPart[] = [];

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => onDone(new Blob(chunks, { type }));

  recorder.start();
  const timer = setTimeout(() => {
    if (recorder.state !== "inactive") recorder.stop();
  }, ms + 400);

  return () => {
    clearTimeout(timer);
    if (recorder.state !== "inactive") recorder.stop();
  };
}
