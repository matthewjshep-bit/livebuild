"use client";

import { getMedia, isManagedRef, refToKey } from "@/lib/media-store";
import { levelBase, planToWorld } from "@/lib/plan/geometry";
import type { CapturePose } from "@/lib/render/capture";
import {
  type Discrepancy,
  type LoopState,
  admissible,
  emptyLoop,
  isVerifiable,
  keeps,
  remember,
  verdict,
} from "@/lib/spec/verify";
import type { HouseSpec, RoomSpec } from "@/lib/spec/schema";
import type { Property, Room, TourNode } from "@/lib/schema";

/**
 * Check one room against its own photograph, and correct what disagrees.
 *
 * Driven by hand, one room at a time, and off unless somebody asks - which is
 * the right default for the only pass here that can make a room worse rather
 * than merely fail to make it better. Everything that stops it doing that lives
 * in `verify.ts` and is tested without spending a request; this is the part
 * that fetches the images and moves the values.
 */

export type VerifyOutcome = {
  spec: RoomSpec;
  /** Every round's score, so the panel can show whether it got anywhere. */
  scores: number[];
  applied: Discrepancy[];
  refused: Array<{ path: string; reason: string }>;
  /** Why it stopped. "It stopped improving" is a real answer. */
  because: string;
  /** Set when the render and the photograph turned out to be different views. */
  poseProblem: string | null;
};

/** Where the camera stood when a photograph was taken, in world terms. */
export function poseOf(property: Property, room: Room, node: TourNode): CapturePose {
  const [x, y, z] = planToWorld(
    node.position,
    levelBase(property.plan, room.level) + node.eyeHeight,
  );
  return {
    position: [x, y, z],
    headingDeg: node.heading,
    pitchDeg: node.pitch ?? 0,
    fovDeg: node.fovDeg,
  };
}

async function photoDataUrl(node: TourNode): Promise<string | null> {
  const blob = isManagedRef(node.photo)
    ? await getMedia(refToKey(node.photo))
    : await fetch(node.photo)
        .then((r) => (r.ok ? r.blob() : null))
        .catch(() => null);
  if (!blob) return null;

  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return null;
  }
}

/** Read a dotted path off a spec, as the string the comparison will see. */
function valueAt(spec: RoomSpec, path: string): string | null {
  const value = path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined,
      spec,
    );
  if (value === undefined || value === null || typeof value === "object") return null;
  return String(value);
}

/** Put a proposed value into the spec, parsed against what the field holds. */
function write(spec: RoomSpec, path: string, proposed: string): boolean {
  const keys = path.split(".");
  const leaf = keys.pop()!;
  let node = spec as unknown as Record<string, unknown>;
  for (const key of keys) {
    if (node[key] === undefined || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }

  const existing = node[leaf];
  let value: string | number | boolean;
  if (typeof existing === "number" || /^-?\d+(\.\d+)?$/.test(proposed)) {
    const parsed = Number(proposed);
    if (!Number.isFinite(parsed)) return false;
    value = parsed;
  } else if (typeof existing === "boolean") {
    value = proposed === "true";
  } else {
    value = proposed;
  }

  node[leaf] = value;
  spec.source[path] = "verified";
  delete spec.because[path];
  return true;
}

/** The paths this room actually has that a comparison could settle. */
function verifiablePaths(spec: RoomSpec): string[] {
  const paths: string[] = [
    "ceiling.heightM",
    "ceiling.kind",
    "trim.baseboardM",
  ];
  if (spec.ceiling?.beams) paths.push("ceiling.beams.count");
  for (const item of spec.joinery ?? []) {
    paths.push(`joinery.${item.id}.lengthM`, `joinery.${item.id}.tier`);
  }
  for (const other of Object.keys(spec.openings ?? {})) {
    paths.push(`openings.${other}.kind`);
  }
  return paths.filter(isVerifiable);
}

/**
 * What a field's number actually means, spelled out for the comparison.
 *
 * `lengthM` and `alongM` are fractions of the wall they sit on, not metres -
 * the names are historical and the schema clamps them to 0..1. Sent bare, a run
 * covering most of a four-metre wall arrives as "0.85", and a model asked how
 * long it is would reasonably answer "3.5" and turn an 85% run into a
 * full-wall one, every time, in the pass whose entire job is making the room
 * more exact. Saying which unit a number is in costs nine characters.
 */
function unitOf(path: string): string {
  if (path.endsWith("lengthM") || path.endsWith("alongM")) return " (fraction of the wall, 0-1)";
  if (path.endsWith("M") || path.endsWith("heightM")) return " m";
  return "";
}

/** Joinery is addressed by id, so a path has to be resolved to an index. */
function resolve(spec: RoomSpec, path: string): string {
  if (!path.startsWith("joinery.")) return path;
  const [, id, field] = path.split(".");
  const index = (spec.joinery ?? []).findIndex((item) => item.id === id);
  return index >= 0 ? `joinery.${index}.${field}` : path;
}

export async function verifyRoom(
  property: Property,
  house: HouseSpec,
  roomId: string,
  capture: (pose: CapturePose) => string | null,
  onRound?: (round: number, score: number) => void,
): Promise<VerifyOutcome | null> {
  const room = property.plan.rooms.find((r) => r.id === roomId);
  const node = property.nodes.find((n) => n.roomId === roomId);
  if (!room || !node) return null;

  const photo = await photoDataUrl(node);
  if (!photo) return null;

  let spec = structuredClone(house.rooms[roomId]);
  if (!spec) return null;

  let loop: LoopState = emptyLoop();
  let best = 0;
  let bestSpec = structuredClone(spec);
  const scores: number[] = [];
  const applied: Discrepancy[] = [];
  const refused: VerifyOutcome["refused"] = [];
  let because = "budget";
  let poseProblem: string | null = null;

  for (let round = 0; round < 8; round++) {
    const render = capture(poseOf(property, room, node));
    if (!render) break;

    const paths = verifiablePaths(spec);
    const current: Record<string, string> = {};
    for (const path of paths) {
      const value = valueAt(spec, resolve(spec, path));
      if (value !== null) current[path] = value + unitOf(path);
    }

    let result: {
      poseFit: { sameViewpoint: boolean; problem: string };
      score: number;
      diffs: Discrepancy[];
    } | null = null;
    try {
      const response = await fetch("/api/room-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room: room.label, render, photo, paths, current }),
      });
      if (response.ok) result = await response.json();
    } catch {
      result = null;
    }
    if (!result) break;

    // Two different views have nothing comparable in them. Stopping is the
    // only safe response - every difference would be the vantage point.
    if (!result.poseFit.sameViewpoint) {
      poseProblem = result.poseFit.problem;
      because = "different-view";
      break;
    }

    scores.push(result.score);
    onRound?.(round + 1, result.score);

    const kept = keeps(result.score, best);
    loop = { ...loop, rounds: [...loop.rounds, { score: result.score, kept }] };

    if (kept) {
      best = result.score;
      bestSpec = structuredClone(spec);
    } else if (round > 0) {
      // Rolled back. The round's corrections did not pay for themselves, and
      // this is the rule that makes the loop unable to end below where it
      // started.
      spec = structuredClone(bestSpec);
    }

    const filtered = admissible(result.diffs, spec, loop);
    refused.push(...filtered.refused);

    const stop = verdict(loop, filtered.apply.length);
    if (stop.done) {
      because = stop.because;
      break;
    }

    for (const diff of filtered.apply) {
      if (write(spec, resolve(spec, diff.path), diff.proposed)) applied.push(diff);
    }
    loop = remember(loop, filtered.apply);
  }

  return {
    // Whichever version actually scored best, not whichever was tried last.
    spec: best > 0 ? bestSpec : spec,
    scores,
    applied,
    refused,
    because,
    poseProblem,
  };
}
