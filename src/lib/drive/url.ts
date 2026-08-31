/**
 * Reading a Google Drive link.
 *
 * Kept apart from the fetching next door because it is pure, and because
 * `server-only` makes anything importing it unrunnable outside a request -
 * which would put the parsing most worth checking out of reach of a test. The
 * same split already exists between `listing/url.ts` and `listing/zillow.ts`.
 */

/** Drive ids are URL-safe base64-ish. Pinned so an id can never be a path. */
export const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;

export type DriveFile = { id: string; name: string; mimeType: string };

/**
 * The folder or file a Drive link points at.
 *
 * Links arrive in more shapes than you would expect - a folder opened from the
 * sidebar carries a `/u/0/`, a share sheet appends `?usp=sharing`, and an old
 * link uses `?id=`. All of them are the same id in the end.
 */
export function parseDriveUrl(input: string): { kind: "folder" | "file"; id: string } | null {
  const text = input.trim();
  if (!text) return null;

  const folder = /drive\.google\.com\/.*?\/folders\/([A-Za-z0-9_-]+)/.exec(text);
  if (folder && DRIVE_ID.test(folder[1])) return { kind: "folder", id: folder[1] };

  const file = /drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/.exec(text);
  if (file && DRIVE_ID.test(file[1])) return { kind: "file", id: file[1] };

  const open = /drive\.google\.com\/open\?[^\s]*\bid=([A-Za-z0-9_-]+)/.exec(text);
  if (open && DRIVE_ID.test(open[1])) return { kind: "file", id: open[1] };

  // A bare id, which is what people paste when they have already pulled it out.
  if (DRIVE_ID.test(text) && !text.includes("/")) return { kind: "folder", id: text };

  return null;
}
