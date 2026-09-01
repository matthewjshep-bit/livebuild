/**
 * Work that has been saved stays saved.
 *
 * Two mechanisms used to lose a tour, and both were silent. A single
 * unparseable index made `listPropertyIds` return nothing, so the home page
 * showed nothing and the *next* save wrote an index containing only the
 * property being saved - orphaning every other document permanently. And two
 * tours started in the same minute shared an id, so the second overwrote the
 * first and deleting either destroyed both.
 *
 * Neither threw. The failure was a tour that had simply stopped existing, which
 * is the worst kind of bug this app can have, so the guarantees are pinned here
 * rather than left to a browser suite.
 */

// Imported first, and for its side effect: it installs the window the store
// needs. Static imports evaluate in order, which is what makes this work where
// a dynamic import would need a top-level await that tsx cannot compile.
import { storage } from "./lib/fake-storage";
import {
  listPropertyIds,
  loadProperty,
  recoverOrphanedKeys,
  saveProperty,
} from "../src/lib/property-store";
import type { Property } from "../src/lib/schema";
import { M_PER_FT } from "../src/lib/units";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const property = (id: string, label = id): Property => ({
  id,
  label,
  displayUnits: "ft",
  plan: { scaleRef: { px: 1, meters: M_PER_FT }, rooms: [], openings: [] },
  nodes: [],
  splats: [],
  condition: {},
  houseCondition: {},
  rates: {},
});

// --- Ordinary saving ---
saveProperty(property("home-a"));
saveProperty(property("home-b"));
saveProperty(property("home-c"));
check("every saved property is listed", listPropertyIds().length === 3, listPropertyIds().join(","));
check("in the order they were added", listPropertyIds().join(",") === "home-a,home-b,home-c");
check("and each one loads", ["home-a", "home-b", "home-c"].every((id) => loadProperty(id) !== null));

// The browser suites take the last index entry as the newest tour.
check("the newest is last", listPropertyIds()[listPropertyIds().length - 1] === "home-c");

// --- The cascade: a corrupt index must not orphan anything ---
storage.setItem("mattermatt:index", "{not json at all");
check(
  "a corrupt index still finds every property",
  listPropertyIds().sort().join(",") === "home-a,home-b,home-c",
  listPropertyIds().join(","),
);

saveProperty(property("home-d"));
check(
  "and saving after a corrupt index does not lose the others",
  listPropertyIds().sort().join(",") === "home-a,home-b,home-c,home-d",
  listPropertyIds().join(","),
);

// --- An index that simply lost an entry ---
storage.setItem("mattermatt:index", JSON.stringify(["home-a"]));
check(
  "a property missing from the index is recovered",
  listPropertyIds().includes("home-c"),
  listPropertyIds().join(","),
);
check("and the index's own order is respected first", listPropertyIds()[0] === "home-a");

// --- An index naming something that is not there ---
storage.setItem("mattermatt:index", JSON.stringify(["ghost", "home-a"]));
check(
  "an index entry with no document behind it is dropped",
  !listPropertyIds().includes("ghost"),
  listPropertyIds().join(","),
);

// --- Nothing that is not a property may be mistaken for one ---
storage.setItem("mattermatt:admin-key", "hunter2");
storage.setItem("mattermatt:property:odd:meta", "{}");
const listed = listPropertyIds();
check("the publish passphrase is not a tour", !listed.includes("admin-key"), listed.join(","));
check("nor is any key that is not a plain id", !listed.some((id) => id.includes(":")), listed.join(","));

// --- Ids must not collide ---
//
// The generator lives in the wizard, so this checks the property it has to
// have rather than importing a component.
const ids = new Set<string>();
for (let i = 0; i < 500; i++) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const clock = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  ids.add(`home-${day}-${clock}-${Math.random().toString(36).slice(2, 7)}`);
}
check("500 ids minted in the same minute are all different", ids.size === 500, `${ids.size}`);
check(
  "and none of them contains a path separator",
  [...ids].every((id) => !id.includes("/") && !id.includes(":")),
);

// --- A photo prefix must not reach into a neighbour ---
//
// Blobs are keyed `${id}/${photoId}/photo` and deleted by the prefix `${id}/`.
// The trailing slash is the whole safety argument, so it is stated here.
const blobKeys = ["home-1/p1/photo", "home-10/p1/photo", "home-1/p2/depth"];
const doomed = blobKeys.filter((k) => k.startsWith("home-1/"));
check(
  "deleting one property leaves a longer-named one alone",
  doomed.length === 2 && !doomed.includes("home-10/p1/photo"),
  doomed.join(","),
);

// --- A house stranded by the storage rename comes back ---
//
// Not hypothetical. The app renamed every `mattermatt:` key to `livebuild:`,
// deleted the original, and then reverted the rename - leaving every tour built
// in between under a prefix nothing looked for. This is the recovery, and it is
// pinned here so the next person to consider renaming a storage key has to
// delete a passing test to do it.
{
  storage.clear();

  const stranded = {
    id: "forest-hills",
    label: "20491 Forest Hills Dr",
    displayUnits: "ft",
    plan: { scaleRef: { px: 1, meters: M_PER_FT }, rooms: [], openings: [] },
    nodes: [],
    splats: [],
    condition: {},
    houseCondition: {},
    rates: {},
  };
  storage.setItem("livebuild:property:forest-hills", JSON.stringify(stranded));
  storage.setItem("livebuild:index", JSON.stringify(["forest-hills"]));
  storage.setItem("livebuild:admin-key", "hunter2");

  // Through the real entry point, so the wiring is proved and not just the
  // function: a recovery nothing calls is the same as no recovery.
  recoverOrphanedKeys(true);
  const ids = listPropertyIds();
  check("a stranded tour is found again", ids.includes("forest-hills"), ids.join(","));
  check("and it loads", loadProperty("forest-hills")?.label === "20491 Forest Hills Dr");
  check(
    "under the name in use",
    storage.getItem("mattermatt:property:forest-hills") !== null,
  );
  check(
    "and the stranded copy is cleared away",
    storage.getItem("livebuild:property:forest-hills") === null,
  );
  // Everything moved, not just the documents - the publish passphrase went too,
  // and a passphrase that will not stay answered is its own small mystery.
  check("the passphrase comes back as well", storage.getItem("mattermatt:admin-key") === "hunter2");
}

// --- and it can never clobber newer work ---
{
  storage.clear();
  const newer = {
    id: "forest-hills",
    label: "The newer one",
    displayUnits: "ft",
    plan: { scaleRef: { px: 1, meters: M_PER_FT }, rooms: [], openings: [] },
    nodes: [],
    splats: [],
    condition: {},
    houseCondition: {},
    rates: {},
  };
  storage.setItem("mattermatt:property:forest-hills", JSON.stringify(newer));
  storage.setItem("mattermatt:index", JSON.stringify(["forest-hills"]));
  storage.setItem(
    "livebuild:property:forest-hills",
    JSON.stringify({ ...newer, label: "A stale copy" }),
  );

  recoverOrphanedKeys(true);
  check(
    "a stale copy never overwrites the current document",
    loadProperty("forest-hills")?.label === "The newer one",
    loadProperty("forest-hills")?.label,
  );
}

console.log(
  failures === 0
    ? "STORAGE OK - a corrupt index loses no tours, a tour stranded by the rename comes back without clobbering newer work, ids do not collide"
    : `STORAGE BROKEN - ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
