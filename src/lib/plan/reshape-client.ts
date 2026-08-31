"use client";

import { type Footprint, type PackPlan, layoutFromFootprint, prepareFootprint } from "@/lib/plan/footprint";
import { arrangeRooms } from "@/lib/plan/layout-client";
import { reshapeProperty } from "@/lib/plan/reshape";
import { roomKind } from "@/lib/plan/room-kind";
import { syntheticRing } from "@/lib/site/trace";
import { readExterior } from "@/lib/site/client";
import { M_PER_FT } from "@/lib/units";
import type { Property } from "@/lib/schema";

/**
 * Work out what an existing tour's floor plan should have been.
 *
 * The same chain a fresh build now uses - the map first, the satellite frame
 * when the map has nothing, and a rectangle with a house's proportions when
 * neither will say. Tours built before any of that existed were packed into an
 * invented square, which is why they came out as grids; this is how they catch
 * up without being made again from the photographs.
 *
 * Nothing is written here. The caller gets a proposal and a picture of where it
 * came from, and decides.
 */

export type ShapeSource = "map" | "traced" | "invented";

export type ReshapeProposal = {
  /** The outline in [lat, lon], whatever found it. */
  ring: Array<[number, number]>;
  source: ShapeSource;
  /** Why the better sources declined, when they did. */
  why: string | null;
  footprint: Footprint;
  /** The document as it would be, ids and photographs intact. */
  next: Property;
  added: string[];
  dropped: string[];
  /** The arrangement pass's account of itself, if it ran. */
  reasoning: string;
  areaSqft: number;
};

export type ReshapeFailure = { error: "no-location" | "no-rooms" | "no-shape" };

/** Room labels either side of every doorway, which is what orders the packing. */
function adjacencyOf(property: Property): Array<[string, string]> {
  const labels = new Map(property.plan.rooms.map((r) => [r.id, r.label]));
  const pairs: Array<[string, string]> = [];
  for (const opening of property.plan.openings) {
    const a = labels.get(opening.between[0]);
    const b = labels.get(opening.between[1]);
    if (a && b && a !== b) pairs.push([a, b]);
  }
  return pairs;
}

/** Floor area the rooms already claim, which is the best target for a new shell. */
function groundSqft(property: Property): number {
  const ground = property.plan.rooms.filter(
    (r) => r.level === 0 && roomKind(r.label) !== "outside",
  );
  let sqm = 0;
  for (const room of ground) {
    const p = room.polygon;
    let sum = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      sum += a[0] * b[1] - b[0] * a[1];
    }
    sqm += Math.abs(sum) / 2;
  }
  return sqm / (M_PER_FT * M_PER_FT);
}

/** The map's outline for a point, or null with the reason it declined. */
async function mapRing(
  lat: number,
  lon: number,
): Promise<{ ring: Array<[number, number]> | null; miss: string | null }> {
  try {
    const response = await fetch("/api/site/shape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lat, lon }),
    });
    if (!response.ok) return { ring: null, miss: "lookup-failed" };
    const data = await response.json();
    const ring = (data.ring as Array<[number, number]> | null) ?? null;
    return { ring, miss: ring ? null : ((data.miss as string) ?? "no-building") };
  } catch {
    return { ring: null, miss: "lookup-failed" };
  }
}

export async function proposeReshape(
  property: Property,
  onStep?: (label: string) => void,
): Promise<ReshapeProposal | ReshapeFailure> {
  const site = property.site;
  if (!site) return { error: "no-location" };

  const rooms = property.plan.rooms;
  if (rooms.length === 0) return { error: "no-rooms" };

  const storeys = Math.max(1, new Set(rooms.map((r) => r.level)).size);
  const sqft = groundSqft(property) || 1600;

  // 1. The map, which is survey data and beats anything read off a picture.
  onStep?.("Asking the map for the building");
  const fromMap = await mapRing(site.lat, site.lon);

  let ring = fromMap.ring;
  let source: ShapeSource = "map";
  let why: string | null = null;

  // 2. The satellite frame. Only reached when the map has nothing, which is the
  //    common case at newer addresses and the whole reason tracing exists.
  if (!ring) {
    onStep?.("Tracing the roof from the satellite");
    why = fromMap.miss === "lookup-failed" ? "the map service did not answer" : "the map has no building here";
    const read = await readExterior({ lat: site.lat, lon: site.lon, outline: [], storeys });
    if (read?.tracedRing) {
      ring = read.tracedRing;
      source = "traced";
    }
  }

  // 3. Proportions. Still better than what these tours have: a rectangle that
  //    is wide and shallow reads as a house, and a square reads as a grid.
  if (!ring) {
    onStep?.("Falling back to a typical shape");
    source = "invented";
    ring = syntheticRing({ lat: site.lat, lon: site.lon }, sqft / storeys);
  }

  const ground = rooms.filter((r) => r.level === 0);
  const footprint = prepareFootprint(ring, sqft, ground.length);

  // 4. Which room goes where. The packer still computes every polygon, so a bad
  //    answer here cannot break the fill - it only chooses the order.
  onStep?.("Arranging the rooms");
  const adjacency = adjacencyOf(property);
  const plans = new Map<number, PackPlan>();
  let reasoning = "";

  const groundLabels = ground.filter((r) => roomKind(r.label) !== "outside").map((r) => r.label);
  const arranged = await arrangeRooms(footprint, groundLabels, adjacency, {
    frontDoorBearing: property.exterior?.frontDoorBearing ?? null,
    garageBearing: property.exterior?.garage?.bearing ?? null,
    planXBearing: 90 + footprint.rotationDeg,
  });
  if (arranged) {
    plans.set(0, arranged.plan);
    reasoning = arranged.reasoning;
  }

  const laid = layoutFromFootprint(
    { rooms: rooms.map((r) => ({ label: r.label, level: r.level })) },
    footprint,
    adjacency,
    plans,
  );

  // 5. Adopt the geometry, keep the identities. Without this every photograph
  //    is orphaned and every grade detached - silently, and with a plan that
  //    looks better than the one it replaced.
  const { property: next, added, dropped } = reshapeProperty(
    property,
    laid,
    90 + footprint.rotationDeg,
  );

  return {
    ring,
    source,
    why,
    footprint,
    next,
    added,
    dropped,
    reasoning,
    areaSqft: footprint.areaSqft,
  };
}
