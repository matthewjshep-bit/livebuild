/**
 * The slug is the access control, so its properties are load-bearing.
 *
 * The tours table has no read policy at all: nothing can list it, and `/t/<slug>`
 * is the only door. That makes every one of these an actual security property
 * rather than a tidiness check, and all of them fail silently - a slug the
 * publish route rejects looks like a network error, a `cloud` field Zod strips
 * looks like a tour that simply syncs twice, and a slug derived from the address
 * looks exactly like one that was not.
 */

import { newSlug, toSlug } from "../src/lib/cloud/config";
import { parseProperty } from "../src/lib/schema";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

console.log("\nslug shape");

// The pattern the publish route enforces. Copied rather than imported because
// that route is server-only; if the two ever drift, every sync 400s.
const ROUTE_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;

const slugs = Array.from({ length: 2000 }, () => newSlug());

check("every slug satisfies the publish route's pattern", slugs.every((s) => ROUTE_PATTERN.test(s)), slugs.find((s) => !ROUTE_PATTERN.test(s)));

// publishProperty runs the override through toSlug before using it. A slug that
// does not survive that round-trip would be stored under one name and linked
// under another.
const mangled = slugs.find((s) => toSlug(s) !== s);
check("toSlug leaves a minted slug alone", mangled === undefined, mangled && `${mangled} -> ${toSlug(mangled!)}`);

check("no collisions across 2000 draws", new Set(slugs).size === slugs.length);
check("long enough not to be brute-forced", slugs.every((s) => s.length >= 20));

// The point of the whole exercise: a link that cannot be reached by knowing
// where the house is.
const address = "20491 Forest Hills Dr, Saratoga CA";
check(
  "a slug is not derived from the address",
  !slugs.some((s) => s.includes(toSlug(address))),
);

console.log("\nthe slug survives the schema");

// The trap. `cloud.slug` is what makes a re-sync update the same row instead of
// minting a second copy of the house - and `parseProperty` strips unknown keys,
// so a field missing from the schema vanishes at exactly the moment it is read
// back, with no error anywhere.
const bare = {
  id: "sync-test",
  label: "Test House",
  plan: { scaleRef: { px: 100, meters: 1 }, rooms: [], openings: [] },
  nodes: [],
};

function parsed(doc: unknown) {
  try {
    return parseProperty(doc);
  } catch (error) {
    check("parseProperty threw", false, error instanceof Error ? error.message : "");
    return null;
  }
}

const withCloud = parsed({ ...bare, cloud: { slug: slugs[0], syncedAt: 1_700_000_000_000 } });
check("the slug survives the round-trip", withCloud?.cloud?.slug === slugs[0], String(withCloud?.cloud?.slug));
check("so does the timestamp", withCloud?.cloud?.syncedAt === 1_700_000_000_000);

// A tour built before any of this existed, and one that has never synced. Both
// have to keep working: the field is optional precisely so that adding it did
// not invalidate every document already in a browser.
const older = parsed(bare);
check("a document with no cloud field still parses", older !== null);
check("and reads as never synced", !older?.cloud);

console.log(`\nverdict: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
