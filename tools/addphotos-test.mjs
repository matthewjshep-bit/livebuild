/**
 * Photographs into a house that already exists.
 *
 * The wizard could do this once and never again: classify, place, pose and
 * depth were all reachable only from `/new`. A tour that came out with no
 * viewpoints - an address whose listing had no gallery - was finished, and the
 * only repair was placing a viewpoint by hand and aiming it yourself.
 *
 * Two things are checked, and the second is the one that would hurt. Adding
 * photographs must add viewpoints; and it must not quietly cost the user the
 * condition they graded by hand, which is keyed by room id and is the expensive
 * thing in the document.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PHOTOS = [
  "public/properties/demo-house/photos/kitchen-01.jpg",
  "public/properties/demo-house/photos/bath-01.jpg",
];

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const ID = `addphotos-${Date.now().toString(36)}`;

// A house with rooms, one graded, and no viewpoints at all - which is exactly
// the state the address-only path leaves behind when a listing has no gallery.
await page.goto(`${BASE}/editor`, { waitUntil: "networkidle" });
await page.evaluate((id) => {
  const room = (rid, label, x) => ({
    id: rid,
    label,
    polygon: [[x, 0], [x + 4, 0], [x + 4, 4], [x, 4]],
    ceilingHeight: 2.7,
    level: 0,
  });
  const property = {
    id,
    label: "Add Photos Fixture",
    displayUnits: "ft",
    plan: {
      scaleRef: { px: 1, meters: 0.3048 },
      rooms: [room("r1", "Kitchen", 0), room("r2", "Bathroom", 4)],
      openings: [],
    },
    nodes: [],
    splats: [],
    condition: { r1: { flooring: "poor" } },
    houseCondition: {},
    rates: {},
  };
  localStorage.setItem("mattermatt:property:" + id, JSON.stringify(property));
  const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
  if (!index.includes(id)) index.push(id);
  localStorage.setItem("mattermatt:index", JSON.stringify(index));
}, ID);

await page.goto(`${BASE}/editor?id=${ID}`, { waitUntil: "networkidle" });
await page.waitForSelector("aside", { timeout: 20_000 });

const before = await page.evaluate(
  (id) => JSON.parse(localStorage.getItem("mattermatt:property:" + id)),
  ID,
);
check("the fixture starts with no viewpoints", before.nodes.length === 0, `${before.nodes.length}`);
check("the fixture starts graded", before.condition?.r1?.flooring === "poor");

// --- Open the panel and drop two photographs in ---
await page.getByRole("button", { name: /Add photos/ }).click();
await page.waitForTimeout(500);
await page.setInputFiles('aside input[type="file"]', PHOTOS);
await page.waitForTimeout(1500);

const addButton = page.getByRole("button", { name: /Add 2 photos to this house/ });
check("the add button offers both photos", (await addButton.count()) === 1);
await addButton.click();

// Classify and pose are real model calls; depth then runs in a worker.
let saved = before;
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(2000);
  saved = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem("mattermatt:property:" + id)),
    ID,
  );
  if (saved.nodes.length > 0) break;
}

check("viewpoints were added", saved.nodes.length === 2, `${saved.nodes.length} nodes`);
check(
  "each viewpoint points at a real room",
  saved.nodes.every((n) => saved.plan.rooms.some((r) => r.id === n.roomId)),
);
check(
  "the two viewpoints do not stand on the same spot",
  saved.nodes.length < 2 ||
    saved.nodes[0].roomId !== saved.nodes[1].roomId ||
    Math.hypot(
      saved.nodes[0].position[0] - saved.nodes[1].position[0],
      saved.nodes[0].position[1] - saved.nodes[1].position[1],
    ) > 0.05,
  JSON.stringify(saved.nodes.map((n) => [n.roomId, n.position])),
);

// --- The plan and the grading are untouched ---
check(
  "the plan is unchanged",
  saved.plan.rooms.length === 2 && saved.plan.rooms.every((r, i) => r.id === before.plan.rooms[i].id),
  JSON.stringify(saved.plan.rooms.map((r) => r.id)),
);
check(
  "the grading survives",
  saved.condition?.r1?.flooring === "poor",
  JSON.stringify(saved.condition),
);

check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  JSON.stringify(
    {
      nodesBefore: before.nodes.length,
      nodesAfter: saved.nodes.length,
      rooms: saved.plan.rooms.map((r) => r.label),
      placedIn: saved.nodes.map((n) => saved.plan.rooms.find((r) => r.id === n.roomId)?.label),
      conditionKept: saved.condition?.r1?.flooring ?? null,
      errors,
      verdict:
        failures === 0
          ? `ADD PHOTOS OK - ${saved.nodes.length} viewpoints added to a finished house, plan and grading untouched`
          : `BROKEN - ${failures} check(s) failed`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
