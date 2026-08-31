import { isDriveConfigured, listDriveFolder } from "@/lib/drive/folder";
import { parseDriveUrl } from "@/lib/drive/url";

/**
 * What is in a shared Drive folder.
 *
 * Answers with names and ids only; the pictures themselves come through
 * `/api/drive/photo`, one at a time, so a folder of a hundred does not have to
 * be held in one response.
 */

export const maxDuration = 60;

export async function GET() {
  return Response.json({ available: isDriveConfigured() });
}

export async function POST(request: Request) {
  if (!isDriveConfigured()) {
    return Response.json(
      {
        error: "not-configured",
        message:
          "Set GOOGLE_DRIVE_API_KEY in .env.local to read Drive folders. A Maps key works too, if it is not restricted to the Maps APIs.",
      },
      { status: 501 },
    );
  }

  let body: { url?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  const parsed = parseDriveUrl(body.url ?? "");
  if (!parsed) {
    return Response.json(
      {
        error: "not-a-drive-link",
        message: "That does not look like a Google Drive link. Copy the folder's share link.",
      },
      { status: 422 },
    );
  }

  // A single file is a folder of one, so the caller needs no second path.
  if (parsed.kind === "file") {
    return Response.json({ files: [{ id: parsed.id, name: "photo", mimeType: "image/jpeg" }] });
  }

  const listing = await listDriveFolder(parsed.id);

  if (listing.status === "ok") {
    return Response.json({ files: listing.files });
  }
  if (listing.status === "not-shared") {
    // Drive answers 403 for a folder that is private *and* for one that does
    // not exist - deliberately, since confirming an id exists would leak it. So
    // the message names both rather than asserting the one we cannot know,
    // which would otherwise send somebody to fix sharing on a typo.
    return Response.json(
      {
        error: "not-shared",
        message:
          "Cannot open that folder. Either the link is wrong, or it is not shared publicly — in Drive: Share → General access → Anyone with the link.",
      },
      { status: 403 },
    );
  }
  if (listing.status === "not-found") {
    return Response.json(
      { error: "not-found", message: "No folder there. Check the link." },
      { status: 404 },
    );
  }
  if (listing.status === "empty") {
    return Response.json(
      { error: "empty", message: "That folder has no photographs in it." },
      { status: 404 },
    );
  }

  return Response.json(
    { error: "lookup-failed", message: "Drive did not answer. Trying again often works." },
    { status: 502 },
  );
}
