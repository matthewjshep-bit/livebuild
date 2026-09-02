/**
 * The name every piece of this app's browser storage sits under.
 *
 * **Deliberately not the product name.** The app is Livebuild.ai; this still
 * says `mattermatt`, and that is not an oversight to be tidied up.
 *
 * A storage key is a contract with data that already exists. Every house
 * anybody has built lives under this prefix in their localStorage, and their
 * photographs live in an IndexedDB database with this name - so changing the
 * string does not rename that data, it abandons it. The houses would still be
 * sitting there, and nothing would ever look for them again.
 *
 * It is named here, once, so that the day there is a reason to move is a single
 * edit plus a migration, rather than a search across a dozen files that has to
 * find every one of them or lose somebody's work. Renaming this constant alone
 * is NOT enough: localStorage would need its keys copied across, and IndexedDB
 * cannot be renamed at all - it has to be opened under both names and its blobs
 * copied, which for a set of listing photos is tens of megabytes.
 */
export const STORAGE_NS = "mattermatt";

/** Where the property documents and their index live in localStorage. */
export const PROPERTY_PREFIX = `${STORAGE_NS}:property:`;
export const INDEX_KEY = `${STORAGE_NS}:index`;

/**
 * The publish passphrase, remembered so it is not asked for on every publish.
 *
 * Read by two unrelated modules - the sync client and the publish panel - which
 * each used to spell it out for themselves. One of them mistyped is a panel
 * that cannot see the key the other just saved, and the symptom is a passphrase
 * prompt that will not stay answered.
 */
export const ADMIN_KEY_STORAGE = `${STORAGE_NS}:admin-key`;

/**
 * A readable id for a property, that will not collide.
 *
 * The date sorts sensibly and stays legible in a URL; the suffix is what makes
 * it an identifier rather than a timestamp. Two tours started in the same
 * minute used to share a document, a photo prefix and each other's fate.
 *
 * The suffix was `Math.random().toString(36).slice(2, 7)` - about 60 million
 * values, which sounds ample and is not: five hundred of them collide in three
 * runs out of a thousand. The comment above it read "an id that cannot
 * collide", and `storage-test` asserted exactly that, so the suite failed a run
 * every few hundred for a reason nobody could reproduce. Eight hex characters
 * is four billion, which makes the same assertion true rather than usually
 * true.
 *
 * It lives here, beside the storage keys it is a key for, so the wizard and the
 * suite that checks it are looking at one function. They were two copies, and a
 * test that reimplements what it is testing can only ever check itself.
 */
export function newPropertyId(now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  const clock = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const unique = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `home-${day}-${clock}-${unique}`;
}
