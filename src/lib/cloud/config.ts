/**
 * Cloud configuration, in one place so "is publishing available?" has a single
 * answer that both the server and the browser can ask.
 *
 * Everything here degrades: with no Supabase project configured the app is
 * exactly what it was - a local-first tour builder - and the publish button
 * explains itself rather than failing.
 */

// A trailing newline is easy to paste into a dashboard field and impossible to
// see afterwards; it turns every request into one against a host that does not
// exist. Trimmed here so it can only ever be wrong once.
export const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
export const SUPABASE_ANON_KEY = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();

/** Bucket holding published photos and depth maps. Public-read. */
export const BUCKET = "tours";

export function isCloudConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/** Public URL for an object in the bucket. */
export function publicUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

/**
 * A URL-safe slug for a property.
 *
 * This ends up in the shareable link, so it is worth it being readable -
 * `/t/123-main-st` tells a recipient what they are opening in a way a uuid
 * never will.
 */
/**
 * A slug nobody can guess.
 *
 * Lives here rather than with the syncing because it is pure and because it
 * belongs next to `toSlug`, which is the thing it exists to *not* be: a slug
 * derived from an address is findable by typing that address, and the tours
 * table has no read policy, so the slug is the entire access control.
 *
 * 24 characters of 36 is about 124 bits. The alphabet is taken modulo 36 from
 * random bytes, which is very slightly biased toward its first four letters -
 * irrelevant at this width, and worth knowing rather than discovering.
 *
 * The `t-` prefix keeps the first character a letter, which the publish route's
 * slug pattern requires, and marks a minted slug apart from a typed one.
 */
export function newSlug(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `t-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}

export function toSlug(input: string): string {
  const base = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return base || "tour";
}
