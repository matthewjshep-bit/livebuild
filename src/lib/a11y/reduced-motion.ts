"use client";

import { useEffect, useState } from "react";

/**
 * Whether this person has asked their system for less motion.
 *
 * Most of the app can answer this in CSS, and does - `globals.css` collapses
 * transitions and animations wholesale. This exists for the part that cannot:
 * the tour's camera is moved by JavaScript on every frame, so no media query
 * reaches it, and it is also the motion that matters most. An 850ms flight
 * through a house is exactly the kind of large-field movement that provokes
 * vestibular symptoms, and it happens on every click.
 *
 * Answers `false` until mounted. The server has no way to know the preference,
 * so rendering as if motion were fine and correcting on the client is the only
 * honest order - and it errs the right way round, because the first paint has
 * no animation running yet.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    // Guarded because this runs in jsdom and in older Safari, where either the
    // API or its listener half is missing - and a throw here would take the
    // whole tour down over a preference.
    let query: MediaQueryList;
    try {
      query = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return;
    }

    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);

    if (query.addEventListener) {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    }
    return undefined;
  }, []);

  return reduced;
}
