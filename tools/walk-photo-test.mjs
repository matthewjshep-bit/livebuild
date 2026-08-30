/**
 * Photographs in the walkthrough, not only behind a clicked ring.
 *
 * The tour used to render its photographs in exactly one of five modes. Walk
 * and Tour were synthetic by construction - `shellOpacity` returned zero
 * whenever no node transition was running, and no shell was even mounted
 * outside `node` mode - so the recorded film of a house contained none of its
 * own photography, however many photographs it had.
 *
 * Whether a shell is actually on screen cannot be seen from outside the canvas,
 * and a screenshot cannot tell a photograph of a wall from a rendering of one.
 * So this reads `window.__shell`, the driver's own readout, the way walk-test
 * reads `window.__walk`.
 *
 * The two halves matter equally. A shell that never appears is the bug this
 * fixes; a shell that never goes away would be worse, because it would be
 * showing a photograph from somewhere the camera is not.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !/pointer lock/i.test(t)) errors.push(t);
});

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

await page.goto(`${BASE}/tour/demo-house`, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 25_000 });
await page.waitForFunction(() => {
  const c = document.querySelector("canvas");
  return c instanceof HTMLCanvasElement && c.width > 0;
}, { timeout: 20_000 });
await page.waitForTimeout(4000);

const shell = () => page.evaluate(() => window.__shell ?? null);

// --- The dollhouse shows no photography, as it always has. ---
const inDollhouse = await shell();
check(
  "the dollhouse keeps the photographs out of the way",
  !inDollhouse || inDollhouse.opacity === 0,
  `opacity ${inDollhouse?.opacity}`,
);

// --- On foot, the nearest viewpoint is tracked and mounted. ---
//
// How solid it gets is `shell-proximity-test.ts`'s job, and belongs there: the
// reach is deliberately about a metre, because a shell viewed from further off
// smears, and a headless walker cannot be steered onto a spot that small
// (pointer lock is refused, so every key press goes wherever yaw happens to
// point). What this can prove is the half that was actually broken - that walk
// mode considers photographs at all, where before it mounted none.
await page.getByRole("button", { name: "Walk" }).click();
await page.waitForTimeout(2500);

const walker = await page.evaluate(() => window.__walk ?? null);
check("walk mode started", Boolean(walker), "no walker state");

const seen = new Set();
let best = { opacity: 0, nodeId: null };
for (let step = 0; step < 20; step++) {
  await page.keyboard.down(step % 2 === 0 ? "KeyW" : "KeyA");
  await page.waitForTimeout(140);
  await page.keyboard.up(step % 2 === 0 ? "KeyW" : "KeyA");
  const now = await shell();
  if (now?.nodeId) seen.add(now.nodeId);
  if (now && now.opacity > best.opacity) best = now;
}

check(
  "walking tracks the nearest viewpoint",
  seen.size > 0,
  "no viewpoint was ever the nearest",
);
check(
  "the walk readout stays a sane opacity",
  best.opacity >= 0 && best.opacity <= 1,
  `saw ${best.opacity}`,
);

// --- The scripted tour stands in the photographs it has. ---
await page.getByRole("button", { name: "Plan", exact: true }).click().catch(() => {});
await page.getByRole("button", { name: "Dollhouse" }).click().catch(() => {});
await page.waitForTimeout(600);
await page.getByRole("button", { name: "Tour", exact: true }).click();

let tourBest = { opacity: 0, nodeId: null };
const visited = new Set();
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(400);
  const now = await shell();
  if (now?.nodeId) visited.add(now.nodeId);
  if (now && now.opacity > tourBest.opacity) tourBest = now;
}

check(
  "the scripted tour stands in its photographs",
  tourBest.opacity > 0.5,
  `best opacity was ${tourBest.opacity.toFixed(2)} across ${visited.size} viewpoint(s)`,
);
check(
  "the tour visits more than one viewpoint",
  visited.size >= 2,
  `visited ${visited.size}`,
);

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log(
  JSON.stringify(
    {
      walk: {
        viewpointsTracked: [...seen],
        bestOpacity: Number(best.opacity.toFixed(3)),
      },
      tour: {
        bestOpacity: Number(tourBest.opacity.toFixed(3)),
        viewpoints: [...visited],
      },
      errors,
      verdict:
        failures === 0
          ? `PHOTOGRAPHS IN THE WALKTHROUGH - the tour stands in ${visited.size} of them; walking tracked ${seen.size}`
          : `BROKEN - ${failures} check(s) failed`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
