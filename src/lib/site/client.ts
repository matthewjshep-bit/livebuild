"use client";

import type { Exterior } from "@/lib/schema";

/**
 * Ask the server to look at the house.
 *
 * An optional upgrade, like every other key in this app: without a Maps key the
 * route reports itself unavailable, this returns null, and the house is built
 * from the map and the photographs exactly as it always was.
 */
export async function readExterior(input: {
  lat: number;
  lon: number;
  outline: Array<[number, number]>;
  storeys: number | null;
}): Promise<Exterior | null> {
  try {
    const response = await fetch("/api/site/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return (data.exterior as Exterior | null) ?? null;
  } catch {
    return null;
  }
}
