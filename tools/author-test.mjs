/**
 * Can you author a plan from nothing?
 *
 * Drives the editor the way a user would: draw two rooms, cut a doorway between
 * them, drop a viewpoint in each. Verifies the walk graph connects them, which
 * is the whole point of the doorway.
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${base}/editor`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const tool = (name) =>
  // Tool labels are lowercase in the DOM; CSS capitalize only changes how they look.
  page.getByRole("button", { name, exact: true }).click();

async function dragRoom(x0, y0, x1, y1) {
  await tool("room");
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

// Two rooms sharing the vertical wall at x=500.
await dragRoom(250, 250, 500, 480);
await dragRoom(500, 250, 760, 480);

// A doorway on that shared wall.
await tool("door");
await page.mouse.click(500, 380);
await page.waitForTimeout(400);

// One viewpoint in each room.
await tool("camera");
await page.mouse.click(330, 330);
await page.waitForTimeout(400);
await tool("camera");
await page.mouse.click(650, 400);
await page.waitForTimeout(900);

const summary = await page.evaluate(() => {
  const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
  const id = index[index.length - 1];
  const doc = JSON.parse(localStorage.getItem("mattermatt:property:" + id) ?? "null");
  return doc && {
    id,
    rooms: doc.plan.rooms.length,
    openings: doc.plan.openings.length,
    nodes: doc.nodes.length,
    neighbors: doc.nodes.map((n) => n.neighbors.length),
  };
});

await page.screenshot({ path: "shots/15-authored.png" });

const connected =
  summary &&
  summary.rooms === 2 &&
  summary.openings === 1 &&
  summary.nodes === 2 &&
  summary.neighbors.every((n) => n > 0);

console.log(JSON.stringify({
  summary,
  errors,
  verdict: connected
    ? "AUTHORING WORKS - 2 rooms, 1 doorway, 2 connected viewpoints"
    : "AUTHORING FAILED",
}, null, 2));

await browser.close();
process.exit(connected && errors.length === 0 ? 0 : 1);
