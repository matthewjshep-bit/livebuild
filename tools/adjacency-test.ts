/**
 * Does an observed connection actually shape the plan?
 *
 * This is the part that decides whether a generated layout reads as *this* house
 * or merely as a house. Shelf packing alone puts rooms wherever the list
 * happened to order them; a kitchen photo showing the dining room through an
 * opening says those two touch, and the plan should reflect that.
 */
import { arrangeForAdjacency, autoLayout, autoOpenings } from "../src/lib/plan/autolayout";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const satisfied = (rooms: ReturnType<typeof autoLayout>, pairs: Array<[string, string]>) => {
  const byLabel = new Map(rooms.map((r) => [r.label, r.id]));
  const touching = new Set(autoOpenings(rooms).map((o) => [...o.between].sort().join("|")));
  return pairs.filter(([a, b]) => {
    const ids = [byLabel.get(a), byLabel.get(b)];
    return ids[0] && ids[1] && touching.has([ids[0], ids[1]].sort().join("|"));
  }).length;
};

// A house where the required connections are deliberately not the packing order.
{
  const labels = [
    "Kitchen", "Bedroom 2", "Garage", "Living Room", "Bathroom",
    "Dining Room", "Bedroom 3", "Primary Bedroom", "Hallway",
  ];
  const required: Array<[string, string]> = [
    ["Kitchen", "Dining Room"],
    ["Dining Room", "Living Room"],
    ["Hallway", "Primary Bedroom"],
    ["Hallway", "Bedroom 2"],
    ["Kitchen", "Garage"],
  ];

  const naive = satisfied(autoLayout(labels), required);
  const arranged = arrangeForAdjacency(labels, required);
  const improved = satisfied(arranged, required);

  check("arranging beats the packing order", improved > naive,
    `${improved}/${required.length} against ${naive}/${required.length} unarranged`);
  check("most observed connections are realised", improved >= required.length - 1,
    `${improved}/${required.length}`);
  check("no rooms are lost in the search", arranged.length === labels.length);

  // The whole house must still be walkable — an arrangement that satisfies
  // adjacencies while stranding a room is worse than the one it replaced.
  const openings = autoOpenings(arranged);
  const adjacency = new Map(arranged.map((r) => [r.id, [] as string[]]));
  for (const o of openings) {
    adjacency.get(o.between[0])?.push(o.between[1]);
    adjacency.get(o.between[1])?.push(o.between[0]);
  }
  const seen = new Set([arranged[0].id]);
  const queue = [arranged[0].id];
  while (queue.length) {
    for (const next of adjacency.get(queue.shift()!) ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  check("the arranged plan is still walkable", seen.size === arranged.length,
    `${seen.size}/${arranged.length}`);
}

// Same photos must give the same house twice; a layout that shuffles between
// runs reads as the tool being unsure of itself.
{
  const labels = ["Kitchen", "Living Room", "Hallway", "Bedroom", "Bathroom"];
  const required: Array<[string, string]> = [["Kitchen", "Living Room"], ["Hallway", "Bedroom"]];
  const a = arrangeForAdjacency(labels, required).map((r) => r.label).join(",");
  const b = arrangeForAdjacency(labels, required).map((r) => r.label).join(",");
  check("the same input gives the same layout", a === b);
}

// With nothing observed it must behave exactly as before.
{
  const labels = ["Kitchen", "Living Room", "Bedroom"];
  const withNone = arrangeForAdjacency(labels, []).map((r) => r.label).join(",");
  const plain = autoLayout(labels).map((r) => r.label).join(",");
  check("no observations changes nothing", withNone === plain);
}

console.log(
  failures === 0
    ? "ADJACENCY OK - observed connections shape the plan, and it stays walkable"
    : `ADJACENCY BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
