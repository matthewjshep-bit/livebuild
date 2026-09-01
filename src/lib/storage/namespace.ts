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
