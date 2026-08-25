import { BUCKET, isAdmin, serviceClient } from "@/lib/cloud/server";

/**
 * Authorise a batch of uploads, then get out of the way.
 *
 * The photos for one house run to tens of megabytes, and a Vercel serverless
 * function caps request bodies at about 4.5MB - so they cannot be proxied
 * through here. Instead the server mints one signed upload URL per file and the
 * browser uploads straight to Supabase. The write credential never leaves the
 * server, and the large transfer never touches it.
 */

const MAX_FILES = 200;

export async function POST(request: Request) {
  const client = serviceClient();
  if (!client) {
    return Response.json({ error: "not-configured" }, { status: 501 });
  }

  let body: { adminKey?: string; slug?: string; paths?: string[] };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  if (!isAdmin(body.adminKey)) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }

  const slug = String(body.slug ?? "").trim();
  const paths = Array.isArray(body.paths) ? body.paths : [];

  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) {
    return Response.json({ error: "bad-slug" }, { status: 400 });
  }
  if (paths.length === 0 || paths.length > MAX_FILES) {
    return Response.json({ error: "bad-paths" }, { status: 400 });
  }
  // Every object must sit under this tour's own prefix, or one publish could
  // overwrite another tour's photos.
  if (!paths.every((p) => typeof p === "string" && /^[\w./-]+$/.test(p) && !p.includes(".."))) {
    return Response.json({ error: "bad-paths" }, { status: 400 });
  }

  const uploads: Array<{ path: string; url: string; token: string }> = [];
  for (const relative of paths) {
    const path = `${slug}/${relative}`;
    const { data, error } = await client.storage
      .from(BUCKET)
      .createSignedUploadUrl(path, { upsert: true });

    if (error || !data) {
      return Response.json(
        { error: "sign-failed", detail: error?.message ?? "unknown", path },
        { status: 502 },
      );
    }
    uploads.push({ path, url: data.signedUrl, token: data.token });
  }

  return Response.json({ bucket: BUCKET, uploads });
}
