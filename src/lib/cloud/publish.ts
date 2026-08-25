"use client";

import { publicUrl, toSlug } from "@/lib/cloud/config";
import { getMedia, refToKey } from "@/lib/media-store";
import type { Property } from "@/lib/schema";

/**
 * Publishing: take a locally-built tour and put it somewhere shareable.
 *
 * Drafting stays local on purpose - tagging thirty photos should not wait on a
 * network - so publishing is the one moment anything is uploaded, and it is
 * explicit. Uploads go straight from the browser to storage using short-lived
 * signed URLs the server mints; nothing large passes through the API route,
 * which could not carry it anyway.
 */

export type PublishProgress = {
  stage: "preparing" | "uploading" | "recording" | "done";
  completed: number;
  total: number;
  bytes: number;
};

/** Photos are downscaled to this on the long edge before upload. */
const MAX_PHOTO_EDGE = 1600;
const PHOTO_QUALITY = 0.82;

/**
 * Shrink a photo for delivery.
 *
 * A listing set is around 90MB raw, against a 1GB free tier - roughly eleven
 * houses. At 1600px the shell has far more detail than its depth map can use,
 * so this costs nothing visible and buys about ten times the capacity.
 *
 * Depth maps are never touched: they encode millimetres across RGB channels,
 * so resampling or JPEG would corrupt the geometry rather than soften it.
 */
async function downscalePhoto(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const longest = Math.max(bitmap.width, bitmap.height);

  if (longest <= MAX_PHOTO_EDGE) {
    bitmap.close();
    return blob;
  }

  const scale = MAX_PHOTO_EDGE / longest;
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return blob;
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const shrunk = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY),
  );
  // If the encoder somehow produced something larger, keep the original.
  return shrunk && shrunk.size < blob.size ? shrunk : blob;
}

type Upload = { relative: string; blob: Blob; nodeId: string; kind: "photo" | "depth" };

/** Gather every local blob this tour needs, downscaling photos on the way. */
async function collect(property: Property): Promise<Upload[]> {
  const uploads: Upload[] = [];

  for (const node of property.nodes) {
    const photo = await getMedia(refToKey(node.photo));
    if (photo) {
      uploads.push({
        relative: `photos/${node.id}.jpg`,
        blob: await downscalePhoto(photo),
        nodeId: node.id,
        kind: "photo",
      });
    }
    if (node.depth) {
      const depth = await getMedia(refToKey(node.depth));
      if (depth) {
        uploads.push({
          relative: `depth/${node.id}.png`,
          blob: depth,
          nodeId: node.id,
          kind: "depth",
        });
      }
    }
  }

  return uploads;
}

export type PublishResult =
  | { ok: true; slug: string; url: string; bytes: number }
  | { ok: false; error: string; detail?: string };

export async function publishProperty(
  property: Property,
  adminKey: string,
  onProgress: (progress: PublishProgress) => void,
  slugOverride?: string,
): Promise<PublishResult> {
  const slug = toSlug(slugOverride || property.label || property.id);

  onProgress({ stage: "preparing", completed: 0, total: 0, bytes: 0 });
  const uploads = await collect(property);

  if (uploads.length === 0) {
    return { ok: false, error: "nothing-to-publish" };
  }

  const prepare = await fetch("/api/publish/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminKey, slug, paths: uploads.map((u) => u.relative) }),
  });

  if (!prepare.ok) {
    const detail = await prepare.json().catch(() => ({}));
    return { ok: false, error: detail.error ?? String(prepare.status) };
  }

  const { uploads: signed } = (await prepare.json()) as {
    uploads: Array<{ path: string; url: string; token: string }>;
  };

  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );

  let bytes = 0;
  for (let i = 0; i < uploads.length; i++) {
    const upload = uploads[i];
    const target = signed[i];

    const { error } = await client.storage
      .from("tours")
      .uploadToSignedUrl(target.path, target.token, upload.blob, {
        contentType: upload.kind === "photo" ? "image/jpeg" : "image/png",
        upsert: true,
      });

    if (error) {
      return { ok: false, error: "upload-failed", detail: error.message };
    }

    bytes += upload.blob.size;
    onProgress({ stage: "uploading", completed: i + 1, total: uploads.length, bytes });
  }

  // Rewrite the document to point at the uploaded copies. The local `idb:`
  // references mean nothing to anyone else's browser.
  const published: Property = {
    ...property,
    id: slug,
    nodes: property.nodes.map((node) => ({
      ...node,
      photo: publicUrl(`${slug}/photos/${node.id}.jpg`),
      depth: node.depth ? publicUrl(`${slug}/depth/${node.id}.png`) : null,
    })),
  };

  onProgress({ stage: "recording", completed: uploads.length, total: uploads.length, bytes });

  const finalize = await fetch("/api/publish/finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adminKey,
      slug,
      document: published,
      photoCount: property.nodes.length,
      bytes,
    }),
  });

  if (!finalize.ok) {
    const detail = await finalize.json().catch(() => ({}));
    return { ok: false, error: detail.error ?? String(finalize.status), detail: detail.detail };
  }

  onProgress({ stage: "done", completed: uploads.length, total: uploads.length, bytes });
  const { url } = (await finalize.json()) as { url: string };
  return { ok: true, slug, url, bytes };
}
