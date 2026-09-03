"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";

import { type SunState } from "@/lib/model/sun";

/**
 * The sky, as something surfaces can reflect.
 *
 * Until now every material in the house was `metalness: 0` with no environment
 * to sample, which is why nothing metal ever read as metal and a window pane
 * read as a pale panel: a mirror with nothing to mirror is just a grey square.
 * Image-based lighting is what fixes that, and it also does properly what the
 * five shadow-casting `SKY_RAYS` were approximating - light arriving from the
 * whole dome rather than from five directions that happen to cast shadows.
 *
 * Drawn in code rather than loaded. drei's `<Environment preset>` fetches an
 * HDR from a CDN, which would break the promise the procedural textures were
 * built to keep: a tour opens offline, downloads nothing, and has nothing to
 * license. A gradient with a sun in it is not a photograph of a real sky, but
 * it carries the two things a reflection needs - a bright warm source and a
 * horizon - and at the sizes these reflections appear at, that is the whole
 * effect.
 *
 * 128 pixels tall. An environment map is only ever seen blurred across a rough
 * surface or smeared across a small bright one, so resolution here buys almost
 * nothing and costs a PMREM convolution on every change of hour.
 */

const HEIGHT = 128;
const WIDTH = HEIGHT * 2;

/** A daylight sky when the house knows where it is, a studio when it does not. */
function paint(sun: SunState | null): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const g = canvas.getContext("2d")!;

  // Darker than instinct suggests, and this is the number that matters most.
  //
  // An environment map contributes diffuse light to every surface facing it,
  // so a near-white sky is very nearly a full white ambient light - it lifts
  // the whole model towards the top of the range and takes the shading with
  // it. The first version of this was `#f2f4f7` and the house came back as a
  // white paper cut-out. What is wanted from the environment is not brightness
  // but *variation*: somewhere bright to reflect and somewhere dim, so a
  // surface tells you which way it faces.
  //
  // Neutral, not blue. A house with no site has no sky, and giving it one
  // tints every upward-facing surface: the first version of this used a
  // blue-grey and the floors came back visibly cold, which reads as a colour
  // management bug rather than as weather.
  //
  // The sited path used to revert to exactly that failure. It took the sun's
  // one sky colour - a saturated blue - and painted it into all three stops
  // at three gains, so the dome was blue overhead, blue at the horizon and
  // blue underfoot, and every surface in the house was multiplied by blue.
  // `sunState` now says what each stop is, and the three are not the same
  // colour: blue overhead, a warm neutral at the horizon, and a lit floor
  // below.
  //
  // On that lower half: it is not sky, it is what the room stands on. It was
  // much darker once, on the reasoning that ground is dimmer than sky - true
  // outdoors, and indoors it is the single thing a ceiling can see. The sun
  // never reaches a ceiling's underside, so with the lower hemisphere near
  // black a ceiling came back at almost zero luminance, and ACES renders
  // near-black as a distinct blue. A floor bounces a good deal of what lands
  // on it, and this is that bounce - warm, because floors are.
  const zenith = sun ? rgb(sun.sky.zenith, 1.0) : "#8a8a89";
  const horizon = sun ? rgb(sun.sky.horizon, 1.0) : "#a3a2a0";
  const ground = sun ? rgb(sun.sky.ground, 1.0) : "#6b6862";

  const sky = g.createLinearGradient(0, 0, 0, HEIGHT / 2);
  sky.addColorStop(0, zenith);
  sky.addColorStop(1, horizon);
  g.fillStyle = sky;
  g.fillRect(0, 0, WIDTH, HEIGHT / 2);

  const below = g.createLinearGradient(0, HEIGHT / 2, 0, HEIGHT);
  below.addColorStop(0, horizon);
  below.addColorStop(0.25, ground);
  below.addColorStop(1, ground);
  g.fillStyle = below;
  g.fillRect(0, HEIGHT / 2, WIDTH, HEIGHT / 2);

  if (sun && sun.day > 0.02) {
    // The sun itself, as a soft disc. Its position has to match the
    // directional light exactly or a chrome tap reflects a sun that is not
    // where the shadows say it is - which nobody can name but everybody sees.
    const [x, y, z] = sun.direction;
    const length = Math.hypot(x, y, z) || 1;
    // Equirectangular: longitude across, latitude down.
    const u = (Math.atan2(x, -z) / (Math.PI * 2) + 0.5) * WIDTH;
    const v = (Math.acos(Math.max(-1, Math.min(1, y / length))) / Math.PI) * HEIGHT;
    const r = HEIGHT * 0.09;

    const disc = g.createRadialGradient(u, v, 0, u, v, r);
    const [cr, cg, cb] = sun.colour;
    disc.addColorStop(0, `rgba(255,255,255,${0.95 * sun.day})`);
    disc.addColorStop(0.35, rgba(cr, cg, cb, 0.7 * sun.day));
    disc.addColorStop(1, rgba(cr, cg, cb, 0));
    g.fillStyle = disc;
    g.fillRect(u - r, v - r, r * 2, r * 2);
    // Wrapped copy, so a sun near the seam is not cut in half.
    g.fillRect(u - r + (u < WIDTH / 2 ? WIDTH : -WIDTH), v - r, r * 2, r * 2);
  }

  return canvas;
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
const rgb = ([r, g, b]: [number, number, number], gain: number) =>
  `rgb(${clamp255(r * gain)},${clamp255(g * gain)},${clamp255(b * gain)})`;
const rgba = (r: number, g: number, b: number, a: number) =>
  `rgba(${clamp255(r)},${clamp255(g)},${clamp255(b)},${a})`;

export function EnvRig({ sun }: { sun: SunState | null }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  // Quantised, so dragging the time-of-day slider does not run a PMREM
  // convolution on every one of the sixty frames it takes to cross the bar.
  const step = sun ? Math.round(sun.altitudeDeg) + Math.round(sun.azimuthDeg) * 1000 : -1;

  const environment = useMemo(() => {
    if (typeof document === "undefined") return null;
    const texture = new THREE.CanvasTexture(paint(sun));
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;

    const pmrem = new THREE.PMREMGenerator(gl);
    const target = pmrem.fromEquirectangular(texture);
    texture.dispose();
    pmrem.dispose();
    return target.texture;
    // `step` stands in for the sun: the object identity changes every frame
    // while the sky only changes when the angle does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, step]);

  useEffect(() => {
    if (!environment) return;
    scene.environment = environment;
    return () => {
      scene.environment = null;
      environment.dispose();
    };
  }, [scene, environment]);

  return null;
}
