"use client";

import { policyFor } from "@/lib/ai/policy";
import { getMedia, isManagedRef, refToKey } from "@/lib/media-store";
import { toJpegDataUrl } from "@/lib/photos/decode";
import type { ExteriorRead } from "@/lib/site/exterior-read";
import { type ExteriorSpec, type Source, EMPTY_EXTERIOR_SPEC, outranks } from "@/lib/spec/schema";
import type { Property } from "@/lib/schema";

/**
 * Read the outside of the house from its photographs, on the client.
 *
 * The same shape as a room read: the photographs are shrunk here, the route
 * is asked once, and what comes back is written over the stored spec without
 * stepping on anything a person has said. One call for the whole house,
 * because the outside is one thing.
 */

const EDGE = policyFor("exterior-read").imageEdge;
const MAX = 5;

const thumbnail = (blob: Blob) => toJpegDataUrl(blob, EDGE, 0.88);

async function photosOf(property: Property): Promise<string[]> {
  const refs = (property.exteriorPhotos ?? []).map((p) => p.photo).slice(0, MAX);
  const out: string[] = [];
  for (const ref of refs) {
    const blob = isManagedRef(ref)
      ? await getMedia(refToKey(ref))
      : await fetch(ref)
          .then((r) => (r.ok ? r.blob() : null))
          .catch(() => null);
    if (!blob) continue;
    const dataUrl = await thumbnail(blob);
    if (dataUrl) out.push(dataUrl);
  }
  return out;
}

/** Write a read value in, unless a person already said otherwise. */
function put(spec: ExteriorSpec, path: string, value: string | boolean | null | undefined, source: Source = "read") {
  if (value === null || value === undefined) return;
  if (!outranks(source, spec.source[path])) return;
  const keys = path.split(".");
  const leaf = keys.pop()!;
  let node = spec as unknown as Record<string, unknown>;
  for (const key of keys) {
    if (node[key] === undefined || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[leaf] = value;
  spec.source[path] = source;
  delete spec.because[path];
}

export async function readExteriorPhotos(
  property: Property,
  existing: ExteriorSpec | null,
): Promise<{ exterior: ExteriorSpec | null; notes: string[] }> {
  const photos = await photosOf(property);
  if (photos.length === 0) return { exterior: existing, notes: [] };

  let result: ExteriorRead;
  try {
    const response = await fetch("/api/exterior-read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        photos,
        hints: { roofShape: property.exterior?.roof?.shape ?? null, storeys: property.exterior?.storeys ?? null },
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const why = (body?.error as string | undefined) ?? String(response.status);
      const message = body?.message ? `: ${body.message}` : "";
      return {
        exterior: existing,
        notes: [
          why === "no-api-key"
            ? "The outside was not read: no API key is configured on the server."
            : `The outside could not be read (${why}${message}).`,
        ],
      };
    }
    result = (await response.json()) as ExteriorRead;
  } catch {
    return { exterior: existing, notes: ["The photographs of the outside could not be sent to be read."] };
  }

  const next: ExteriorSpec = {
    ...EMPTY_EXTERIOR_SPEC,
    ...(existing ?? {}),
    source: { ...(existing?.source ?? {}) },
    because: { ...(existing?.because ?? {}) },
    observed: true,
    notes: result.notes ?? "",
  };
  put(next, "siding.material", result.siding.material);
  put(next, "siding.finish", result.siding.finish);
  put(next, "siding.colour", result.siding.colour);
  put(next, "roof.shape", result.roof.shape);
  put(next, "roof.material", result.roof.material);
  put(next, "roof.colour", result.roof.colour);
  put(next, "trim.colour", result.trim.colour);
  put(next, "door.colour", result.door.colour);
  // The garden is replaced wholesale: a photograph is its only source, and a
  // second read should describe the garden rather than plant it twice.
  if (outranks("read", next.source["features"])) {
    next.features = result.features;
    next.source["features"] = "read";
    delete next.because["features"];
  }

  const said = [
    result.siding.material ? `${result.siding.material} walls` : null,
    result.roof.material ?? (result.roof.colour ? "the roof colour" : null),
    result.features.length ? `${result.features.length} things in the garden` : null,
  ].filter(Boolean);
  return {
    exterior: next,
    notes: said.length ? [`Read the outside from its photographs: ${said.join(", ")}.`] : [],
  };
}
