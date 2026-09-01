import { reconcileInventory } from "../src/lib/plan/inventory";
import { roomKinds } from "../src/lib/plan/room-kind";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) { failures++; console.error(`  FAIL ${name}${detail ? " - " + detail : ""}`); }
};
const labels = (r: { label: string }[]) => r.map((x) => x.label);
const beds = (r: { label: string }[]) =>
  r.filter((x) => roomKinds(x.label).some((k) => k === "bedroom" || k === "primary-bedroom")).length;

// The real case: 20 photos of a 4-bed named six rooms, two of them bedrooms.
{
  const shot = [
    { label: "Kitchen/Living Room", level: 0 },
    { label: "Primary Bedroom", level: 0 },
    { label: "Bedroom 2", level: 0 },
    { label: "Primary Ensuite", level: 0 },
    { label: "Outside", level: 0 },
  ];
  const r = reconcileInventory(shot, { beds: 4, baths: 2.5 });
  check("photographed rooms all survive", shot.every((s) => labels(r.rooms).includes(s.label)));
  check("bedrooms reach the listing count", beds(r.rooms) === 4, `got ${beds(r.rooms)}`);
  const fulls = r.rooms.filter((x) => roomKinds(x.label).includes("bathroom")).length;
  check("two full baths", fulls === 2, `got ${fulls}: ${JSON.stringify(labels(r.rooms))}`);
  check("a powder room exists", labels(r.rooms).includes("Powder Room"));
  check("nothing was renamed onto an existing room", new Set(labels(r.rooms)).size === r.rooms.length);
  check("the shortfall is reported", r.notes.length === 2, JSON.stringify(r.notes));
}

// Numbering continues past what is there; it never reuses a taken name.
{
  const r = reconcileInventory(
    [{ label: "Bedroom 2", level: 1 }, { label: "Bedroom 3", level: 1 }],
    { beds: 4, baths: null },
  );
  check("no duplicate labels", new Set(labels(r.rooms)).size === r.rooms.length, JSON.stringify(labels(r.rooms)));
  check("added beds land beside the others", r.added.every((a) => a.level === 1));
  check("added exactly the shortfall", r.added.length === 2, JSON.stringify(labels(r.added)));
}

// Photographs outrank the listing, in one direction only.
{
  const shot = [1, 2, 3, 4, 5].map((n) => ({ label: `Bedroom ${n}`, level: 0 }));
  const r = reconcileInventory(shot, { beds: 3, baths: 1 });
  check("a listing that undercounts removes nothing", beds(r.rooms) === 5, `got ${beds(r.rooms)}`);
  check("no note when nothing was added", r.notes.length === 1, JSON.stringify(r.notes));
}

// A compound label is not miscounted as a bedroom or a bath.
{
  const r = reconcileInventory([{ label: "Kitchen/Living Room", level: 0 }], { beds: 1, baths: 1 });
  check("compound room counts as neither", r.added.length === 2, JSON.stringify(labels(r.added)));
}

// Missing facts do nothing at all, which is the common case for a bare address.
{
  const shot = [{ label: "Kitchen", level: 0 }];
  const r = reconcileInventory(shot, { beds: null, baths: null });
  check("no facts, no change", r.rooms.length === 1 && r.added.length === 0);
}

// An ensuite is a bathroom as far as a listing is concerned.
{
  const r = reconcileInventory(
    [{ label: "Primary Ensuite", level: 0 }, { label: "Bathroom", level: 0 }],
    { beds: null, baths: 2 },
  );
  check("ensuite counts toward the bath total", r.added.length === 0, JSON.stringify(labels(r.added)));
}

if (failures > 0) { console.error(`\nINVENTORY: ${failures} failure(s)`); process.exit(1); }
console.log("INVENTORY OK - a house has the bedrooms and bathrooms the listing claims, photographed rooms always survive, and a listing that undercounts is ignored");
