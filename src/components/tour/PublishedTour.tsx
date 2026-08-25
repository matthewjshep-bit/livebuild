"use client";

import { TourViewer } from "@/components/tour/TourViewer";
import type { Property } from "@/lib/schema";

/**
 * Client wrapper for a published tour.
 *
 * Its media is already at public URLs, so none of the local-storage hydration
 * applies - and `onPropertyChange` is deliberately omitted, which is what keeps
 * the "finish processing" prompt off a viewer's screen. A buyer has no business
 * being offered a depth-estimation job.
 */
export function PublishedTour({ property }: { property: Property }) {
  return <TourViewer property={property} />;
}
