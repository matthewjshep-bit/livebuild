"use client";

import {
  Bloom,
  EffectComposer,
  N8AO,
  SMAA,
  ToneMapping,
} from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";

import type { Quality } from "@/lib/render/quality";

/**
 * The pass that puts the model in contact with itself.
 *
 * Ambient occlusion is the one worth having. Everything else here is polish;
 * occlusion is the difference between furniture standing on a floor and
 * furniture hovering a millimetre above it. The five shadow-casting sky rays
 * this replaces were partly an attempt at the same thing - darkening the
 * places light cannot easily reach - done with shadow maps, which is both more
 * expensive and worse at it.
 *
 * Two traps are wired around here, and both fail silently.
 *
 * **Antialiasing.** Mounting a composer replaces the default framebuffer, and
 * the canvas' `antialias: true` MSAA goes with it. Nothing warns; the model
 * simply acquires stair-stepped edges that read as "cheap render" without
 * anyone being able to say why. So SMAA is not an optional nicety here, it is
 * the replacement for something that was already working.
 *
 * **Tone mapping.** The renderer's own ACES pass runs on the way out of the
 * main render, and the composer then writes its result to the screen - so
 * leaving `gl.toneMapping` set and adding a `ToneMapping` effect applies the
 * curve twice and flattens everything. The renderer's is turned off in
 * `TourViewer` and the curve moved in here, where it belongs: it should be the
 * last thing that happens, after bloom, not before it.
 */
export function Post({ quality }: { quality: Quality }) {
  // On a phone the composer itself is affordable and the occlusion pass is
  // not, so the low tier keeps the antialiasing and drops the rest. That
  // ordering matters: dropping SMAA to save the AO would trade a subtle
  // improvement for an obvious regression.
  //
  // Medium gets occlusion too. It was high-only, and medium is what a
  // four-core laptop detects as - so most machines rendered a house with no
  // contact shadow at all, which is most of the difference between a room and
  // a box. It runs at half resolution there, which is the cheap half.
  const occlusion = quality !== "low";
  const bloom = quality !== "low";

  return (
    <EffectComposer
      // The scene is opaque again now the photo shells are gone, so a depth
      // prepass is worth having and the occlusion pass has real depth to read.
      enableNormalPass={occlusion}
      multisampling={0}
    >
      {occlusion ? (
        <N8AO
          // Half a metre. Occlusion is a contact effect: the darkening that
          // matters is where a skirting meets a floor and where a worktop
          // meets a wall, not a general dimming of the room.
          aoRadius={0.5}
          intensity={2.2}
          distanceFalloff={0.7}
          halfRes
        />
      ) : (
        <></>
      )}
      {bloom ? (
        <Bloom
          // High enough that only a window or a lamp reaches it. A bloom that
          // catches white walls is a bloom that makes the house look foggy.
          luminanceThreshold={0.92}
          luminanceSmoothing={0.2}
          intensity={0.35}
          mipmapBlur
        />
      ) : (
        <></>
      )}
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <SMAA />
    </EffectComposer>
  );
}
