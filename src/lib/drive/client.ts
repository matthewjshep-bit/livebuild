"use client";

/**
 * Pulling a shared folder in, from the browser.
 *
 * The same shape as the listing importer next door and for the same reasons: a
 * deadline on every file, a few at a time so a folder of forty is not a minute
 * of nothing happening, and one unreachable picture costs that picture rather
 * than the import.
 */

const PHOTO_TIMEOUT_MS = 45_000;
const CONCURRENCY = 4;

export type DriveFile = { id: string; name: string; mimeType: string };

export class DriveError extends Error {}

/** What is in the folder, or why it cannot be read. */
export async function listDrivePhotos(url: string): Promise<DriveFile[]> {
  const response = await fetch("/api/drive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new DriveError(data.message ?? "That folder could not be read.");
  }
  return (data.files ?? []) as DriveFile[];
}

/**
 * Download them, in order, skipping whatever will not come.
 *
 * Order is preserved even though the requests overlap: a gallery that arrives
 * shuffled reads as a different house, and the names carry the sequence the
 * photographer shot in.
 */
export async function fetchDrivePhotos(
  files: DriveFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<File[]> {
  const out: Array<{ index: number; file: File }> = [];

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);

    const settled = await Promise.all(
      batch.map(async (item, offset) => {
        try {
          const response = await fetch(`/api/drive/photo?id=${encodeURIComponent(item.id)}`, {
            signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
          });
          if (!response.ok) return null;
          const blob = await response.blob();
          const name = /\.(jpe?g|png|webp|heic|heif)$/i.test(item.name)
            ? item.name
            : `${item.name}.jpg`;
          return {
            index: i + offset,
            file: new File([blob], name, { type: blob.type || "image/jpeg" }),
          };
        } catch {
          return null;
        }
      }),
    );

    for (const item of settled) if (item) out.push(item);
    onProgress?.(Math.min(i + CONCURRENCY, files.length), files.length);
  }

  return out.sort((a, b) => a.index - b.index).map((item) => item.file);
}
