import { isAdmin, serviceClient } from "@/lib/cloud/server";
import { parseProperty } from "@/lib/schema";

/**
 * Record the tour once its media is uploaded.
 *
 * Deliberately the last step: if the browser dies partway through uploading,
 * no row is written and the tour simply does not appear. Orphaned objects in
 * storage are cheap and overwritten by the next attempt at the same slug;
 * a row pointing at photos that were never uploaded would be a broken tour.
 */

export async function POST(request: Request) {
  const client = serviceClient();
  if (!client) {
    return Response.json({ error: "not-configured" }, { status: 501 });
  }

  let body: {
    adminKey?: string;
    slug?: string;
    document?: unknown;
    photoCount?: number;
    bytes?: number;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  if (!isAdmin(body.adminKey)) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }

  const slug = String(body.slug ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) {
    return Response.json({ error: "bad-slug" }, { status: 400 });
  }

  // Validate against the same schema the viewer parses with, so a malformed
  // document is rejected here rather than half-rendering for a buyer.
  let document;
  try {
    document = parseProperty(body.document);
  } catch {
    return Response.json({ error: "bad-document" }, { status: 422 });
  }

  const { error } = await client.from("tours").upsert(
    {
      slug,
      label: document.label || slug,
      document,
      photo_count: Number(body.photoCount ?? document.nodes.length) || 0,
      bytes: Number(body.bytes ?? 0) || 0,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "slug" },
  );

  if (error) {
    return Response.json({ error: "write-failed", detail: error.message }, { status: 502 });
  }

  return Response.json({ slug, url: `/t/${slug}` });
}
