/**
 * Reading a pasted link, without needing a server.
 *
 * Kept out of `zillow.ts` because that module is server-only - it holds the
 * scraper call - and this is pure string work the browser wants too: the front
 * door can name the property from the link the moment it is pasted, before any
 * request goes anywhere.
 */

/**
 * The street address buried in a Zillow URL.
 *
 * Zillow puts it in the path - `/homedetails/902-23rd-Ave-E-Seattle-WA-98112/`
 * - which is worth reading rather than treating the link as an opaque handle.
 * It means a pasted link still locates the building on the map when no scraper
 * token is configured, and it gives the geocoder something to work with when
 * the scrape itself fails.
 *
 * Deliberately loose: the result is fed to a geocoder, which is far better at
 * untangling "902 23rd Ave E Seattle WA 98112" than any parsing here would be.
 */
export function addressFromZillowUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)zillow\.com$/i.test(url.hostname)) return null;

  for (const segment of url.pathname.split("/")) {
    // The address slug is the one with hyphen-separated words and a number in
    // it; `homedetails`, `homes` and the `..._zpid` id are not it.
    const cleaned = segment.replace(/_(rb|zpid)$/i, "");
    if (!cleaned.includes("-")) continue;
    if (/^\d+_/.test(cleaned)) continue;
    if (!/\d/.test(cleaned)) continue;
    const address = cleaned.replace(/-/g, " ").trim();
    if (address.length >= 8) return address;
  }
  return null;
}

/** Whether what the user typed is a link rather than an address. */
export function looksLikeUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}
