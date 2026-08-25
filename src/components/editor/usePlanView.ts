"use client";

import { useCallback, useRef, useState } from "react";

import type { Plan, Vec2 } from "@/lib/schema";
import { planBounds } from "@/lib/plan/geometry";

/**
 * Pan and zoom for the editor canvas, kept in plan-space metres.
 *
 * The SVG viewBox is expressed directly in metres rather than pixels, so every
 * interaction handler works in the same units the data model uses and there is
 * no pixels-to-metres conversion scattered through the drawing code.
 */
export type PlanView = { x: number; y: number; width: number; height: number };

export function usePlanView(plan: Plan) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<PlanView>(() => initialView(plan));

  /** Pointer position in plan metres. */
  const toPlan = useCallback((clientX: number, clientY: number): Vec2 => {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const rect = svg.getBoundingClientRect();
    return [
      view.x + ((clientX - rect.left) / rect.width) * view.width,
      view.y + ((clientY - rect.top) / rect.height) * view.height,
    ];
  }, [view]);

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;

    setView((current) => {
      const width = clamp(current.width * factor, 2, 400);
      const height = (width / current.width) * current.height;
      // Keep whatever is under the cursor pinned there while the scale changes.
      return {
        width,
        height,
        x: current.x + (current.width - width) * fx,
        y: current.y + (current.height - height) * fy,
      };
    });
  }, []);

  const panBy = useCallback((dxPx: number, dyPx: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    setView((current) => ({
      ...current,
      x: current.x - (dxPx / rect.width) * current.width,
      y: current.y - (dyPx / rect.height) * current.height,
    }));
  }, []);

  const fit = useCallback(() => setView(initialView(plan)), [plan]);

  return { svgRef, view, setView, toPlan, zoomAt, panBy, fit };
}

function initialView(plan: Plan): PlanView {
  const { min, max } = planBounds(plan);
  const width = Math.max(max[0] - min[0], 6) * 1.35;
  const height = Math.max(max[1] - min[1], 6) * 1.35;
  const size = Math.max(width, height);
  return {
    x: (min[0] + max[0]) / 2 - size / 2,
    y: (min[1] + max[1]) / 2 - size / 2,
    width: size,
    height: size,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
