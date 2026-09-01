import { isAdmin, serviceClient } from "@/lib/cloud/server";

/**
 * Every tour that has been published, for the person who published them.
 *
 * A published tour is reachable only at `/t/<slug>`, and the slug is 24 random
 * characters because the slug *is* the access control - there are no accounts,
 * and the table has row-level security on with no read policies. That is the
 * right design for sharing a house with a buyer, and it has one cost: lose the
 * link and the tour is gone. Nothing on the site listed them, so a house
 * published from a laptop that has since been wiped was unreachable by anyone,
 * including whoever made it.
 *
 * So this is an enumeration, and it sits behind the same shared passphrase that
 * authorises publishing. That is deliberate rather than lazy: the passphrase
 * already gates writing to this table, so anybody holding it can already list
 * what they have written by other means. The unguessable slug remains the
 * public access control and nothing here weakens it - a visitor with a link
 * still gets exactly one house, and no way to ask what else exists.
 *
 * A POST rather than a GET, because the passphrase travels in the body. In a
 * query string it would end up in server logs, in browser history, and in the
 * referrer of every request the page went on to make.
 */

/** Enough to be useful, few enough that a huge table cannot be dumped at once. */
const MAX = 200;

export async function POST(request: Request) {
  const client = serviceClient();
  if (!client) {
    return Response.json({ error: "not-configured" }, { status: 501 });
  }

  let body: { adminKey?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  // Trimmed on the way in, because the passphrase is typed by a person and a
  // trailing space from a copy-paste is not a different passphrase.
  if (!isAdmin((body.adminKey ?? "").trim())) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }

  // Never the document itself. A dozen houses of geometry is megabytes, and
  // this only needs enough to recognise one and open it.
  const { data, error } = await client
    .from("tours")
    .select("slug,label,photo_count,bytes,created_at,updated_at")
    .order("updated_at", { ascending: false })
    .limit(MAX);

  if (error) {
    return Response.json({ error: "query-failed" }, { status: 502 });
  }

  return Response.json({ tours: data ?? [] });
}
