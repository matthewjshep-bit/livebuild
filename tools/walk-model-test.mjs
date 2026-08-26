/**
 * Walking the model on foot, rather than jumping between photographs.
 *
 * Mouse look cannot be tested here - a headless browser refuses pointer lock,
 * which is a browser policy rather than a bug - so this checks the half that
 * decides whether the mode is usable at all: that you start somewhere sensible,
 * that walking moves you, and that a wall stops you.
 *
 * Walking through a wall is the single most obviously broken thing a
 * first-person view can do, and it is invisible from a screenshot.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
// Pointer lock is refused headlessly and says so on the console. That is the
// environment, not the code, so it is not counted against the run.
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

await page.getByRole("button", { name: "Walk" }).click();
await page.waitForTimeout(2500);

const walker = () => page.evaluate(() => window.__walk ?? null);

const start = await walker();
check("walking puts you in the house", Boolean(start), "no walker state");
if (!start) {
  console.log("WALK MODEL BROKEN - never entered walk mode");
  await browser.close();
  process.exit(1);
}

// The demo house's Living Room is [0,0] to [5.5,4.5] - the largest room, and
// where the walker should be dropped.
check("you start inside a room, not in a wall",
  start.x > 0.3 && start.x < 5.2 && start.y > 0.3 && start.y < 4.2,
  `${start.x.toFixed(2)}, ${start.y.toFixed(2)}`);
check("the eye is at standing height", Math.abs(start.eye - 1.62) < 0.05, `${start.eye}`);
check("the camera is where the walker is",
  Math.abs(start.camera[0] - start.x) < 0.01 && Math.abs(start.camera[2] - start.y) < 0.01);

// Forward, into the far wall. Two seconds at 1.5 m/s is more than the room is
// deep, so this both moves and arrives.
await page.keyboard.down("w");
await page.waitForTimeout(2600);
await page.keyboard.up("w");
await page.waitForTimeout(500);
const forward = await walker();

const travelled = Math.hypot(forward.x - start.x, forward.y - start.y);
check("pressing forward moves you", travelled > 0.5, `${travelled.toFixed(2)} m`);

// The room's own walls are the bound. A walker that left them walked through
// one, which no screenshot would have shown.
check("a wall stops you", forward.x > -0.1 && forward.x < 9.6 && forward.y > -0.1 && forward.y < 10.1,
  `ended at ${forward.x.toFixed(2)}, ${forward.y.toFixed(2)}`);
check("you are still on the ground floor", forward.level === 0, `level ${forward.level}`);

// Hold forward far longer than the house is long. If collision is doing its
// job the position converges; without it the walker keeps going for ever.
await page.keyboard.down("w");
await page.waitForTimeout(4000);
await page.keyboard.up("w");
await page.waitForTimeout(500);
const pressed = await walker();
const beyond = Math.hypot(pressed.x - forward.x, pressed.y - forward.y);
check("holding forward against a wall does not push through it", beyond < 0.6,
  `drifted a further ${beyond.toFixed(2)} m`);

check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  failures === 0
    ? `WALK MODEL OK - dropped into a room at eye height, walked ${travelled.toFixed(1)} m, stopped by a wall`
    : `WALK MODEL BROKEN - ${failures} failures`,
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
