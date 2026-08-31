import "server-only";

import { DRIVE_ID, type DriveFile } from "@/lib/drive/url";

/**
 * A folder of photographs, from a link somebody sent.
 *
 * The way property photographs actually arrive is a Drive link in an email, and
 * the alternative this replaces is downloading thirty files to a laptop and
 * dragging them back in. Nothing else about the wizard changes: the pictures
 * land in the same media store under the same keys as a dropped file, and the
 * build cannot tell where they came from.
 *
 * **Read with an API key, so only publicly-shared folders open.** That is
 * almost always the right fit - a link sent to somebody outside the
 * organisation is shared "anyone with the link" or it would not open for them
 * either - and it costs no sign-in, no consent screen and no token to keep. A
 * folder shared privately to one account needs OAuth, and the honest answer
 * there is to say so and let them change the share setting, which takes ten
 * seconds.
 */

/**
 * Drive rejects a Maps-restricted key, and the same project usually holds both.
 *
 * So this looks for its own key first and falls back to the Maps one, which
 * works when the key is unrestricted. Getting a 403 with a perfectly valid key
 * is otherwise a confusing thing to debug, and the error below says so.
 */
const key = () =>
  (process.env.GOOGLE_DRIVE_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY ?? "").trim();

export function isDriveConfigured(): boolean {
  return key().length > 0;
}

const API = "https://www.googleapis.com/drive/v3/files";

export type DriveListing =
  | { status: "ok"; files: DriveFile[]; name: string | null }
  | { status: "not-shared" }
  | { status: "not-found" }
  | { status: "empty" }
  | { status: "error"; detail: string };

/** Only things a build can actually use. Drive folders collect PDFs too. */
const IMAGE = /^image\/(jpeg|png|webp|heic|heif)$/i;

/**
 * Every photograph in a shared folder, newest listing order preserved.
 *
 * Paged, because a property folder of a hundred images is not unusual and Drive
 * returns a hundred at a time.
 */
export async function listDriveFolder(folderId: string): Promise<DriveListing> {
  if (!isDriveConfigured()) return { status: "error", detail: "not-configured" };
  if (!DRIVE_ID.test(folderId)) return { status: "not-found" };

  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  try {
    for (let page = 0; page < 10; page++) {
      const url =
        `${API}?q=${encodeURIComponent(`'${folderId}' in parents and trashed = false`)}` +
        `&fields=nextPageToken,files(id,name,mimeType)` +
        `&pageSize=100&orderBy=name` +
        // A folder on a shared drive is invisible without both of these, and
        // the failure looks exactly like an empty folder.
        `&supportsAllDrives=true&includeItemsFromAllDrives=true` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "") +
        `&key=${encodeURIComponent(key())}`;

      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });

      if (response.status === 404) return { status: "not-found" };
      // 403 is the ordinary case rather than a bug, and it is deliberately
      // ambiguous: Drive answers it both for a folder that is private and for
      // one that does not exist, because confirming an id exists would leak
      // it. The caller's message has to cover both.
      if (response.status === 403 || response.status === 401) return { status: "not-shared" };
      if (!response.ok) return { status: "error", detail: `http-${response.status}` };

      const data = (await response.json()) as {
        nextPageToken?: string;
        files?: DriveFile[];
      };
      for (const file of data.files ?? []) {
        if (IMAGE.test(file.mimeType)) files.push(file);
      }

      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : "failed" };
  }

  if (files.length === 0) return { status: "empty" };
  return { status: "ok", files, name: null };
}

/**
 * One file's bytes.
 *
 * The id is checked against the same pattern the parser enforces, and the URL
 * is built here rather than passed in - so this cannot be pointed at anything
 * but Drive, however it is called.
 */
export async function fetchDriveFile(fileId: string): Promise<Response | null> {
  if (!isDriveConfigured() || !DRIVE_ID.test(fileId)) return null;

  const url =
    `${API}/${fileId}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(key())}`;

  try {
    const response = await fetch(url, {
      headers: { accept: "image/*" },
      signal: AbortSignal.timeout(45_000),
    });
    return response.ok ? response : null;
  } catch {
    return null;
  }
}
