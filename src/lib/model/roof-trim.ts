import type { Part } from "@/lib/model/parts";
import type { RoofFace, RoofModel } from "@/lib/model/roof";

/**
 * What finishes a roof at its edges: fascia boards along the eaves with a
 * gutter under them and a downpipe at each end, rake boards up the gable
 * ends, and a cap along the ridge and down every hip.
 *
 * Read off the roof's own faces rather than built alongside them, so a
 * change to the roof's shape carries its trim with it. An edge with both
 * ends at the eave height is an eave; a sloped edge that no other slope
 * shares is a rake; a sloped or level edge that two slopes share is a hip or
 * the ridge. The boards are thin faces of their own, thickened the way the
 * roof is, so a gable end's rake follows the slope exactly.
 */

type P = [number, number, number];

export type RoofTrim = {
  /** Vertical boards along the eaves and up the rakes, as faces wound outward. */
  boards: RoofFace[];
  /** The trough under each eave, as a face to thicken downward. */
  gutters: RoofFace[];
  /** Caps straddling the ridge and the hips, lying on the slopes. */
  caps: RoofFace[];
  /** Vertical pipes from the gutters' ends to the ground. */
  downpipes: Part[];
};

const FASCIA_DROP = 0.05;
const FASCIA_RISE = 0.15;
const FASCIA_OUT = 0.03;
const GUTTER_OUT = 0.13;
const CAP_REACH = 0.15;
const PIPE = 0.08;

const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: P, k: number): P => [a[0] * k, a[1] * k, a[2] * k];
const cross = (u: P, v: P): P => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const norm = (v: P): P => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const key = (p: P) => p.map((v) => v.toFixed(4)).join(",");
const edgeKey = (a: P, b: P) => [key(a), key(b)].sort().join("|");

function centroid(points: P[]): P {
  return mul(points.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / points.length);
}

/** The face's outward normal, from its winding. */
function normalOf(f: RoofFace): P {
  return norm(cross(sub(f.points[1], f.points[0]), sub(f.points[2], f.points[0])));
}

/** Level, unit, pointing away from the face across this edge. */
function outwardAcross(f: RoofFace, a: P, b: P): P {
  const mid = mul(add(a, b), 0.5);
  const away = sub(mid, centroid(f.points));
  const flat: P = [away[0], 0, away[2]];
  if (Math.hypot(flat[0], flat[2]) < 1e-6) {
    // A ridge seen from a flat face: use the edge's own perpendicular.
    const e = sub(b, a);
    return norm([e[2], 0, -e[0]]);
  }
  return norm(flat);
}

/** A face wound so its normal points the way `outward` does. */
function face(points: P[], outward: P): RoofFace {
  const n = cross(sub(points[1], points[0]), sub(points[2], points[0]));
  const dot = n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2];
  return { points: dot >= 0 ? points : [...points].reverse(), kind: "trim" };
}

export function roofTrim(model: RoofModel): RoofTrim {
  const EPS = 1e-4;
  const boards: RoofFace[] = [];
  const gutters: RoofFace[] = [];
  const caps: RoofFace[] = [];
  const downpipes: Part[] = [];
  const pipeAt = new Set<string>();

  const slopes = model.faces.filter((f) => f.kind === "slope" || f.kind === "flat");
  // Which sloped edges are shared: hips and the ridge.
  const shared = new Map<string, RoofFace[]>();
  for (const f of slopes) {
    for (let i = 0; i < f.points.length; i++) {
      const a = f.points[i];
      const b = f.points[(i + 1) % f.points.length];
      const k = edgeKey(a, b);
      shared.set(k, [...(shared.get(k) ?? []), f]);
    }
  }
  const capped = new Set<string>();

  for (const f of slopes) {
    const n = normalOf(f);
    for (let i = 0; i < f.points.length; i++) {
      const a = f.points[i];
      const b = f.points[(i + 1) % f.points.length];
      const atEave = Math.abs(a[1] - model.eaveY) < EPS && Math.abs(b[1] - model.eaveY) < EPS;
      const owners = shared.get(edgeKey(a, b)) ?? [];
      const out = outwardAcross(f, a, b);

      if (atEave) {
        // Fascia: a vertical board along the eave, just outside it.
        const o = mul(out, FASCIA_OUT);
        const lo = -FASCIA_DROP;
        const hi = FASCIA_RISE;
        boards.push(
          face([add(a, [o[0], lo, o[2]]), add(b, [o[0], lo, o[2]]), add(b, [o[0], hi, o[2]]), add(a, [o[0], hi, o[2]])], out),
        );
        // The gutter: a level face under the fascia's foot, thickened down.
        const g0 = mul(out, FASCIA_OUT);
        const g1 = mul(out, GUTTER_OUT);
        const y = -FASCIA_DROP;
        gutters.push(
          face([add(a, [g0[0], y, g0[2]]), add(b, [g0[0], y, g0[2]]), add(b, [g1[0], y, g1[2]]), add(a, [g1[0], y, g1[2]])], [0, 1, 0]),
        );
        // A downpipe at each end, once per corner.
        for (const [end, other] of [[a, b], [b, a]] as const) {
          const k = key(end);
          if (pipeAt.has(k)) continue;
          pipeAt.add(k);
          const inward = norm(sub(other, end));
          const at = add(add(end, mul(out, GUTTER_OUT + PIPE / 2)), mul(inward, 0.15));
          const height = model.eaveY - FASCIA_DROP - 0.05;
          downpipes.push({
            center: [at[0], height / 2, at[2]],
            size: [PIPE, height, PIPE],
            angleDeg: (Math.atan2(out[2], out[0]) * 180) / Math.PI,
            colour: "#8e8e8a",
            part: "downpipe",
          });
        }
        continue;
      }

      if (owners.length >= 2) {
        // Shared: the ridge or a hip. One cap per edge, straddling it on both faces.
        const k = edgeKey(a, b);
        if (capped.has(k)) continue;
        capped.add(k);
        for (const owner of owners) {
          const on = normalOf(owner);
          const down = norm(sub(centroid(owner.points), mul(add(a, b), 0.5)));
          const lift = mul(on, 0.012);
          const reach = mul(down, CAP_REACH);
          caps.push(face([add(a, lift), add(b, lift), add(add(b, reach), lift), add(add(a, reach), lift)], on));
        }
        continue;
      }

      // Unshared and not level: a rake, up a gable end. A vertical board
      // following the slope, just outside the edge.
      if (Math.abs(a[1] - b[1]) > EPS && f.kind === "slope") {
        const o = mul(out, FASCIA_OUT);
        const drop: P = [0, -FASCIA_DROP, 0];
        const rise: P = [0, FASCIA_RISE, 0];
        boards.push(face([add(add(a, o), drop), add(add(b, o), drop), add(add(b, o), rise), add(add(a, o), rise)], out));
      }
    }
    void n;
  }

  return { boards, gutters, caps, downpipes };
}
