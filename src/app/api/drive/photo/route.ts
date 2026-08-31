import { fetchDriveFile } from "@/lib/drive/folder";

/**
 * Stream one Drive photograph through this origin.
 *
 * Same reason as the listing proxy next door: the browser cannot read bytes it
 * is not allowed to, and the key must not leave the server. Unlike that one
 * there is no host allowlist to get right, because nothing here takes a URL -
 * only an id, which is checked against Drive's own id shape and then built into
 * a Drive URL server-side. It cannot be pointed anywhere else.
 */

export const maxDuration = 60;

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return new Response("missing id", { status: 400 });

  const upstream = await fetchDriveFile(id);
  if (!upstream || !upstream.body) return new Response("upstream failed", { status: 502 });

  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "image/jpeg",
      // A Drive file id is stable and its contents effectively are too, so a
      // retry after a failed import does not re-download the ones that worked.
      "cache-control": "public, max-age=86400",
    },
  });
}
