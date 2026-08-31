"use client";

import type { Grade, HouseElement } from "@/lib/bom/condition";
import type { Exterior } from "@/lib/schema";

/**
 * Ask the server to look at the house.
 *
 * An optional upgrade, like every other key in this app: without a Maps key the
 * route reports itself unavailable, this returns null, and the house is built
 * from the map and the photographs exactly as it always was.
 */
export type SiteRead = {
  exterior: Exterior | null;
  /**
   * What the roof, siding, windows, landscaping and foundation are in.
   *
   * Read off the same satellite and street-level pictures as the appearance,
   * in the same request. Elements the imagery could not show are absent rather
   * than marked unseen, because the bill of materials already reads an absent
   * grade that way and an explicit one would claim somebody looked.
   */
  condition: Partial<Record<HouseElement, Grade>>;
  conditionNotes: string;
};

export async function readExterior(input: {
  lat: number;
  lon: number;
  outline: Array<[number, number]>;
  storeys: number | null;
}): Promise<SiteRead | null> {
  try {
    const response = await fetch("/api/site/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return {
      exterior: (data.exterior as Exterior | null) ?? null,
      condition: (data.condition ?? {}) as Partial<Record<HouseElement, Grade>>,
      conditionNotes: typeof data.conditionNotes === "string" ? data.conditionNotes : "",
    };
  } catch {
    return null;
  }
}
