/**
 * Screenshot the app in a headless browser.
 *
 * WebGL work cannot be verified by checking that a route returns 200 - the
 * scene is built entirely on the client. This drives a real browser, fails
 * loudly on any console error, and writes a PNG to look at.
 *
 *   node tools/shoot.mjs /tour/demo-house shots/tour.png [--click-ring]
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const [route = "/", out = "shots/shot.png", ...flags] = process.argv.slice(2);
const base = process.env.BASE_URL ?? "http://localhost:3000";

const browser = await chromium.launch({
  args: [
    // Headless chromium has no GPU, so WebGL has to fall back to SwiftShader.
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`console: ${m.text()}`);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(base + route, { waitUntil: "networkidle" });

/**
 * Wait for the camera to stop moving, not for a fixed number of seconds.
 *
 * A flat 3.5s was enough until the scene grew an occlusion pass. Headless
 * chromium has no GPU, so under SwiftShader a frame can take the better part of
 * a second at the "Best" quality tier - and the opening camera flight is driven
 * per frame, so the shot came out partway through it. The house looked wrongly
 * framed, which is indistinguishable from having actually broken the framing:
 * I lost a while to that before working out the camera was simply still moving.
 *
 * `window.__camera` is written every frame by `CameraRig`, so this watches it
 * settle instead of guessing. Falls back to a plain wait for the plan view and
 * anything else with no camera at all.
 */
await page.waitForTimeout(1200);
const settled = await page
  .waitForFunction(
    () => {
      const readout = window.__camera;
      if (!readout) return false;
      const previous = window.__shotLast;
      window.__shotLast = readout.position;
      if (!previous) return false;
      const moved = Math.hypot(
        readout.position[0] - previous[0],
        readout.position[1] - previous[1],
        readout.position[2] - previous[2],
      );
      return moved < 0.002;
    },
    { timeout: 45_000, polling: 350 },
  )
  .then(() => true)
  .catch(() => false);

// Textures decode on their own schedule after the camera has arrived.
await page.waitForTimeout(settled ? 1200 : 3500);

const gl = await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  if (!canvas) return { canvas: false };
  const ctx = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  return {
    canvas: true,
    size: [canvas.width, canvas.height],
    renderer: ctx?.getParameter(ctx.RENDERER) ?? null,
  };
});

const clickFlag = flags.find((f) => f.startsWith("--click-text="));
if (clickFlag) {
  await page.getByRole("button", { name: clickFlag.slice(13), exact: true }).first().click();
  await page.waitForTimeout(1800);
}

if (flags.includes("--click-ring")) {
  // Step into a viewpoint: the rings sit on the floor, so aim below centre.
  await page.mouse.click(640, 520);
  await page.waitForTimeout(2200);
}

await mkdir(dirname(out), { recursive: true });
await page.screenshot({ path: out });

console.log(JSON.stringify({ route, out, gl, cameraSettled: settled, problems }, null, 2));
await browser.close();
process.exit(problems.length ? 1 : 0);
