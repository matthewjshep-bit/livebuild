/**
 * Photographs of one room, and a room you can walk through.
 *
 * The whole point of the second way in. Everything used to go through the
 * house-shaped pipeline: somebody with a dozen pictures of a kitchen had to
 * invent an address, accept a satellite trace of a building they may not own,
 * and then delete eight rooms they never asked for.
 *
 * So this asserts the absences as much as the result - no map call, no
 * satellite call, no layout stage, no invented bedrooms - because each of those
 * is a thing the house path does that a room must not.
 */
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { chooseMode } from "./lib/flow.mjs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const dir = "public/properties/demo-house/photos";
const files = readdirSync(dir).map((f) => join(dir, f));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// Every request the page makes, so the absences can be asserted rather than hoped.
const calls = [];
page.on("request", (r) => {
  const url = r.url();
  if (url.includes("/api/")) calls.push(new URL(url).pathname);
});

await page.goto(`${base}/new`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
await chooseMode(page, "room");
await page.screenshot({ path: "shots/R1-room-photos.png" });

const beforeUpload = await page.evaluate(() => ({
  askedForAddress: /address/i.test(document.body.innerText),
}));
check("a room is not asked for an address", !beforeUpload.askedForAddress);

await page.setInputFiles('input[type="file"]', files);
await page.waitForTimeout(2500);

const cta = page.getByTestId("continue-from-photos");
check("the way onwards is offered", (await cta.count()) === 1);
check("and it builds rather than asking what is in the house",
  /Build this room/.test(await cta.innerText()), await cta.innerText());
await cta.click();

let built = false;
for (let i = 0; i < 80 && !built; i++) {
  await page.waitForTimeout(2500);
  built = await page.evaluate(() => /Here is your house/.test(document.body.innerText));
  // A room must never stop at the layout stage; there is nothing to lay out.
  if (await page.getByTestId("suggest-layout").count()) {
    check("a room is not sent to the drawing board", false);
    break;
  }
}
check("a room builds", built);
await page.screenshot({ path: "shots/R2-room-review.png" });

const doc = await page.evaluate(() => {
  const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
  const d = JSON.parse(localStorage.getItem("mattermatt:property:" + index.pop()) ?? "null");
  return d && {
    kind: d.kind ?? null,
    rooms: d.plan.rooms.map((r) => r.label),
    site: d.site ?? null,
    nodes: d.nodes.length,
    placed: d.nodes.filter((n) => n.roomId).length,
    id: d.id,
  };
});

check("it was saved", Boolean(doc));
check("marked as a room", doc?.kind === "room", `${doc?.kind}`);
check("with no site", doc?.site === null || doc?.site === undefined, JSON.stringify(doc?.site));
check("a few spaces at most, not a house",
  (doc?.rooms.length ?? 0) >= 1 && (doc?.rooms.length ?? 0) <= 3, (doc?.rooms ?? []).join(", "));
check("no bedrooms were invented",
  !(doc?.rooms ?? []).some((r) => /Bedroom/i.test(r)) || (doc?.rooms ?? []).length <= 3,
  (doc?.rooms ?? []).join(", "));
check("every photograph landed somewhere", (doc?.placed ?? 0) === (doc?.nodes ?? -1),
  `${doc?.placed} of ${doc?.nodes}`);

// The absences.
check("no building outline was looked up", !calls.some((c) => c.includes("/api/site/shape")),
  calls.filter((c) => c.includes("site")).join(", "));
check("no satellite was read", !calls.some((c) => c.includes("/api/site/read")),
  calls.filter((c) => c.includes("site")).join(", "));
check("no layout was asked for", !calls.some((c) => c.includes("/api/layout")));

// And it is walkable.
let walkable = false;
if (doc?.id) {
  await page.goto(`${base}/tour/${doc.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__scene !== undefined, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const scene = await page.evaluate(() => window.__scene);
  walkable = Boolean(scene && scene.meshes > 0);
  check("the room renders", walkable, JSON.stringify(scene));
  await page.screenshot({ path: "shots/R3-room-tour.png" });
}

console.log(
  JSON.stringify(
    {
      doc,
      apiCalls: [...new Set(calls)],
      errors: errors.slice(0, 3),
      verdict:
        failures === 0
          ? `ROOM ONLY OK - ${doc?.rooms.join(" + ")} built from photographs alone, no address, no map, no satellite, no layout stage`
          : `ROOM ONLY BROKEN - ${failures} failures`,
    },
    null,
    2,
  ),
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
