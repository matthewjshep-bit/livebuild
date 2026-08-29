"use client";

import { Html, Line } from "@react-three/drei";
import * as THREE from "three";

import { formatLength } from "@/lib/units";

/**
 * Two clicks and a dimension.
 *
 * The model already knows every distance in the house - the point of this is
 * that it will answer a question nobody wrote down in advance. Will the sofa
 * fit on that wall, how wide is the gap beside the island, is there room to
 * open the oven. A room schedule cannot anticipate those and a tape measure in
 * the model can.
 *
 * Deliberately not snapped to anything. Snapping to corners would be more
 * precise and would answer a different question - the useful measurement is
 * very often between two points that are not features, like the clear width
 * between a counter and an island.
 */

export type MeasurePoints = { a: THREE.Vector3 | null; b: THREE.Vector3 | null };

export function Measure({
  points,
  displayUnits,
}: {
  points: MeasurePoints;
  displayUnits: "ft" | "m";
}) {
  const { a, b } = points;
  if (!a) return null;

  const distance = b ? a.distanceTo(b) : 0;
  const mid = b ? a.clone().lerp(b, 0.5) : a;

  return (
    <group>
      <Marker at={a} />
      {b && <Marker at={b} />}

      {b && (
        <Line
          points={[a, b]}
          color="#4bb3fd"
          lineWidth={2.5}
          // Drawn over everything. A dimension hidden behind the wall it
          // measures is worse than no dimension.
          depthTest={false}
          renderOrder={999}
        />
      )}

      {b && (
        <Html position={mid} center zIndexRange={[100, 0]}>
          <div className="pointer-events-none whitespace-nowrap rounded bg-accent px-2 py-0.5 text-[11px] font-semibold text-ink-900 shadow">
            {formatLength(distance, displayUnits)}
          </div>
        </Html>
      )}
    </group>
  );
}

function Marker({ at }: { at: THREE.Vector3 }) {
  return (
    <mesh position={at} renderOrder={999}>
      <sphereGeometry args={[0.045, 12, 12]} />
      <meshBasicMaterial color="#4bb3fd" depthTest={false} />
    </mesh>
  );
}
