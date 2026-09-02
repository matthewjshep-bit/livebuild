"use client";

/**
 * Getting a photograph the browser can actually use.
 *
 * Every photo taken on an iPhone since 2017 is HEIC, and a Mac's Photos library
 * hands them over as HEIC. **Chrome and Firefox cannot decode HEIC at all** -
 * `createImageBitmap` throws `InvalidStateError` and an `<img>` never fires
 * `load`. Safari decodes it fine. That split is the whole reason this exists,
 * and it is measured rather than assumed: `tools/heic-test.mjs` runs a real
 * HEIC through both engines.
 *
 * So a file is decoded once, on the way in, and stored as JPEG. Three things
 * follow from doing it here rather than later:
 *
 * - **The thumbnails work.** A blob the browser cannot decode is a blank
 *   rectangle in the photo strip, and nothing says why.
 * - **The vision passes work.** They each re-encode to JPEG before sending,
 *   because the API does not take HEIC either - and each of them would have
 *   failed on the same undecodable blob, three steps and one minute later than
 *   here.
 * - **Storage stops being the limit.** Thirty 12-megapixel photos is over a
 *   hundred megabytes of IndexedDB for images nothing ever renders above a
 *   thousand pixels.
 *
 * And a file that cannot be decoded is *reported*, not dropped. It used to be
 * filtered out by MIME type with no message at all: select thirty HEICs and the
 * page did nothing whatsoever, which is the worst answer available.
 */

/**
 * The largest a stored photo needs to be.
 *
 * Twice what the hungriest vision pass asks for (`sketch` and `pose` want
 * 1024), so re-encoding for those still starts from more detail than they use,
 * and a photograph opened full-screen beside the model still looks like one.
 */
export const STORED_EDGE = 2048;

/** High, because these are the originals everything else is derived from. */
export const STORED_QUALITY = 0.92;

/** Decode, and scale to fit inside `edge`. Null when the browser cannot read it. */
async function draw(blob: Blob, edge: number): Promise<HTMLCanvasElement | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    // HEIC outside Safari, a truncated download, something that is not an image.
    return null;
  }
  try {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    bitmap.close();
  }
}

/** A JPEG data URL of `blob`, for the passes that send one. Null if unreadable. */
export async function toJpegDataUrl(
  blob: Blob,
  edge: number,
  quality: number,
): Promise<string | null> {
  const canvas = await draw(blob, edge);
  return canvas ? canvas.toDataURL("image/jpeg", quality) : null;
}

export type ImportedFile =
  | { ok: true; file: File }
  | { ok: false; name: string; why: "undecodable" | "not-an-image" };

/**
 * One file, ready to store: decoded, scaled and re-encoded as JPEG.
 *
 * Keeps the original name with a `.jpg` extension, because the name is what a
 * person recognises the photograph by and `IMG_4021.HEIC` becoming `blob` helps
 * nobody.
 */
export async function importImage(file: File): Promise<ImportedFile> {
  // A picker on macOS sometimes reports no type at all, so the type is a hint
  // and the decode is the test. Anything obviously not an image is refused
  // without spending a decode on it.
  if (file.type && !file.type.startsWith("image/")) {
    return { ok: false, name: file.name, why: "not-an-image" };
  }

  const canvas = await draw(file, STORED_EDGE);
  if (!canvas) return { ok: false, name: file.name, why: "undecodable" };

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", STORED_QUALITY),
  );
  if (!blob) return { ok: false, name: file.name, why: "undecodable" };

  const name = file.name.replace(/\.[^.]+$/, "") || "photo";
  return {
    ok: true,
    file: new File([blob], `${name}.jpg`, { type: "image/jpeg", lastModified: file.lastModified }),
  };
}

/**
 * What to tell somebody about the files that did not come in.
 *
 * Named, and with the reason, because "some photos could not be read" is not
 * something anybody can act on. HEIC gets its own sentence: it is far and away
 * the common case, it is not the user's fault, and there is something they can
 * actually do about it.
 */
export function refusedMessage(refused: ImportedFile[]): string | null {
  const bad = refused.filter((r): r is Extract<ImportedFile, { ok: false }> => !r.ok);
  if (bad.length === 0) return null;

  const undecodable = bad.filter((r) => r.why === "undecodable");
  const names = bad.slice(0, 3).map((r) => r.name).join(", ");
  const more = bad.length > 3 ? ` and ${bad.length - 3} more` : "";

  if (undecodable.length === bad.length && bad.some((r) => /\.hei[cf]$/i.test(r.name))) {
    return (
      `This browser cannot read HEIC photos, which is what a Mac's Photos library gives you: ${names}${more}. ` +
      `Safari can read them, or in Photos use File › Export › Export Unmodified Original and choose JPEG.`
    );
  }
  return `Could not read ${names}${more}. ${bad.length === 1 ? "It is" : "They are"} not an image this browser can open.`;
}
