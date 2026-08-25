import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublishedTour } from "@/components/tour/PublishedTour";
import { serviceClient } from "@/lib/cloud/server";
import { parseProperty } from "@/lib/schema";

/**
 * A published tour: the shareable half of the product.
 *
 * No account, no local storage, no model download - the depth maps were
 * computed once by whoever built it and uploaded alongside the photos. A buyer
 * opens a link and walks the house.
 *
 * Rendered on the server so the link previews properly when it is pasted into
 * a message, which is how these actually get shared.
 */

export const revalidate = 60;

async function fetchTour(slug: string) {
  const client = serviceClient();
  if (!client) return null;

  const { data, error } = await client
    .from("tours")
    .select("slug,label,document")
    .eq("slug", slug)
    .maybeSingle();

  if (error || !data) return null;

  try {
    return { label: data.label as string, property: parseProperty(data.document) };
  } catch {
    // A document that no longer matches the schema is a 404 rather than a
    // crash: the viewer should not show a half-built house.
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const tour = await fetchTour(slug);
  if (!tour) return { title: "Tour not found" };

  const rooms = tour.property.plan.rooms.length;
  return {
    title: `${tour.label} — MatterMatt`,
    description: `Walk through ${tour.label}: ${rooms} rooms, ${tour.property.nodes.length} viewpoints.`,
    openGraph: {
      title: tour.label,
      description: `Walk through ${rooms} rooms in 3D.`,
    },
  };
}

export default async function PublishedTourPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tour = await fetchTour(slug);
  if (!tour) notFound();

  return <PublishedTour property={tour.property} />;
}
