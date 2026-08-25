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

// Give texture loads and the first animated frames time to settle.
await page.waitForTimeout(3500);

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

console.log(JSON.stringify({ route, out, gl, problems }, null, 2));
await browser.close();
process.exit(problems.length ? 1 : 0);
