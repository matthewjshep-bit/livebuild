/**
 * Is the shell really 3D, or has it degenerated into a billboard?
 *
 * A flat photo would look identical in a still frame, so only motion tells them
 * apart - and only *differential* motion. Under camera lean a billboard shifts
 * as one rigid image; a depth shell moves near geometry further than far.
 *
 * Two regions, both read off shots/07-inside.png at this exact viewport so they
 * are not guesswork:
 *
 *   NEAR - the sofa's silhouette against the floor. A real depth discontinuity;
 *          the thing that must move if the shell has any depth at all.
 *   FAR  - flat wall high on the left, several metres back and unoccluded.
 *
 * The minimap is bottom-right and static, so neither region goes near it.
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const route = process.argv[2] ?? "/tour/demo-house?node=n1";

// Must match the viewport the regions were measured in.
const VIEWPORT = { width: 1280, height: 820 };
const NEAR_REGION = { x0: 370, y0: 585, x1: 790, y1: 700 };
const FAR_REGION = { x0: 60, y0: 230, x1: 470, y1: 360 };

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: VIEWPORT });
await page.goto(base + route, { waitUntil: "networkidle" });
await page.waitForTimeout(3500);

async function shotAt(x, y) {
  await page.mouse.move(x, y);
  // The lean eases toward its target, so let it arrive before capturing.
  await page.waitForTimeout(1600);
  return PNG.sync.read(await page.screenshot());
}

const left = await shotAt(90, 410);
const right = await shotAt(1190, 410);

await mkdir("shots", { recursive: true });
await writeFile("shots/parallax-left.png", PNG.sync.write(left));
await writeFile("shots/parallax-right.png", PNG.sync.write(right));

function regionChange(a, b, r) {
  let sum = 0;
  let n = 0;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const i = (a.width * y + x) << 2;
      sum +=
        Math.abs(a.data[i] - b.data[i]) +
        Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]);
      n += 3;
    }
  }
  return sum / n;
}

const near = regionChange(left, right, NEAR_REGION);
const far = regionChange(left, right, FAR_REGION);
const ratio = near / Math.max(far, 0.01);

console.log(
  JSON.stringify(
    {
      nearEdgeChange: +near.toFixed(2),
      farWallChange: +far.toFixed(2),
      ratio: +ratio.toFixed(2),
      verdict:
        ratio > 1.5 && near > 2
          ? "PARALLAX CONFIRMED - the near silhouette moved far more than the wall behind it"
          : "NO PARALLAX - near and far moved alike, which is what a billboard does",
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(ratio > 1.5 && near > 2 ? 0 : 1);
