/**
 * Can you actually walk upstairs?
 *
 * The cross-storey case has two failure modes that a still frame hides: the
 * neighbour exists in the graph but has no visible ring, or the ring is drawn
 * somewhere nobody would click - metres above your head, in the ceiling.
 * Clicking is the only thing that tests both.
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${base}/tour/two-storey?node=n4`, { waitUntil: "networkidle" });
await page.waitForTimeout(3500);

const at = () => new URL(page.url()).searchParams.get("node");
const start = at();

// Route 1: the minimap. Switch it to the upstairs plan and tap a dot there.
// This is the deliberate way to reach a floor you are not on.
await page.getByRole("button", { name: /Upstairs/ }).first().click();
await page.waitForTimeout(600);
await page.locator("circle").last().click({ force: true });
await page.waitForTimeout(1800);
const viaMinimap = at();

// Route 2: the stairs ring in the world. From the ground-floor hallway the
// stairwell is straight ahead, so scan the centre column only - a blind sweep
// just finds whichever ring is nearest and ping-pongs between rooms.
await page.goto(`${base}/tour/two-storey?node=n4`, { waitUntil: "networkidle" });
await page.waitForTimeout(3500);
let viaStairs = null;
for (let y = 520; y <= 720 && !viaStairs; y += 12) {
  for (let x = 560; x <= 720; x += 20) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(90);
    if (at() !== "n4") {
      viaStairs = { node: at(), at: [x, y] };
      break;
    }
  }
}

await page.screenshot({ path: "shots/45-after-stairs.png" });

const UP = ["n5", "n6"];
const minimapWorks = UP.includes(viaMinimap);
const stairsWork = viaStairs && UP.includes(viaStairs.node);

console.log(
  JSON.stringify(
    {
      start,
      viaMinimap,
      viaStairs,
      errors: errors.slice(0, 3),
      verdict:
        minimapWorks && stairsWork
          ? "BOTH ROUTES UPSTAIRS WORK - the minimap and the stairs ring"
          : minimapWorks
            ? "ONLY THE MINIMAP REACHES UPSTAIRS - the stairs ring did not respond"
            : stairsWork
              ? "ONLY THE STAIRS RING WORKS - the minimap did not"
              : "STUCK DOWNSTAIRS",
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(minimapWorks && stairsWork && errors.length === 0 ? 0 : 1);
