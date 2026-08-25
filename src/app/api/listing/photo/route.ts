/**
 * Stream a listing photo through this origin.
 *
 * Zillow's image hosts serve pictures happily but send no CORS headers, so the
 * browser cannot read the bytes to store them - a plain `fetch` fails, and an
 * `<img>` renders but cannot be turned into a blob. Proxying is the only way to
 * get the pixels into IndexedDB.
 *
 * The host allowlist is what stops this being an open proxy for anyone who
 * finds the URL.
 */

const ALLOWED_HOSTS = [
  "photos.zillowstatic.com",
  "maps.zillowstatic.com",
  "www.zillowstatic.com",
];

export async function GET(request: Request) {
  const target = new URL(request.url).searchParams.get("url");
  if (!target) {
    return new Response("missing url", { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new Response("bad url", { status: 400 });
  }

  if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.includes(parsed.hostname)) {
    return new Response("host not allowed", { status: 403 });
  }

  const upstream = await fetch(parsed.toString(), {
    headers: { accept: "image/*" },
    signal: AbortSignal.timeout(30_000),
  });

  if (!upstream.ok || !upstream.body) {
    return new Response("upstream failed", { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "image/jpeg",
      // Immutable: these URLs carry a content hash, so a long cache is safe and
      // saves re-fetching forty photos on every retry.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
