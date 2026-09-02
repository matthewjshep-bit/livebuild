"use client";

import { useEffect, useState } from "react";

/**
 * The satellite tile for a place, with the numbers needed to put it somewhere.
 *
 * Fetched rather than dropped into an `<img src>`, because the route returns
 * the tile's real size and ground resolution in headers and both are needed to
 * place it. The zoom is clamped server-side, so the extent asked for and the
 * extent received are not always the same number - assuming otherwise puts the
 * picture at the wrong scale, which on a satellite image of a house is a
 * mistake that looks like a slightly different house.
 *
 * Imagery is never persisted, which the licence requires and the object URL
 * enforces: it lives as long as the component and is revoked on the way out.
 */

export type SiteTile = {
  href: string;
  sizePx: number;
  metresPerPixel: number;
};

export function useSiteTile(
  place: { lat: number; lon: number; extentM: number } | null,
): SiteTile | null {
  const [tile, setTile] = useState<SiteTile | null>(null);

  useEffect(() => {
    if (!place) {
      setTile(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    (async () => {
      try {
        const response = await fetch(
          `/api/site/tile?lat=${place.lat}&lon=${place.lon}&extent=${place.extentM}`,
        );
        if (!response.ok) return;

        const sizePx = Number(response.headers.get("x-tile-size"));
        const metresPerPixel = Number(response.headers.get("x-tile-mpp"));
        if (!Number.isFinite(sizePx) || !Number.isFinite(metresPerPixel)) return;
        if (sizePx <= 0 || metresPerPixel <= 0) return;

        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setTile({ href: objectUrl, sizePx, metresPerPixel });
      } catch {
        // No imagery is a plainer drawing surface, not an error. A house down a
        // private track has no usable picture and never will.
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // The coordinates, not the object holding them. A caller that builds
    // `{ lat, lon, extentM }` inline hands over a new object every render, and
    // depending on it would refetch the satellite tile on each one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place?.lat, place?.lon, place?.extentM]);

  return tile;
}
