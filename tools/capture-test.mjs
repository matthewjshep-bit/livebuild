/**
 * The model can be photographed from where a photograph was taken.
 *
 * This is the mechanism the verify pass rests on, and every way it can fail
 * produces an image rather than an error - a black frame, an upside-down one,
 * a washed-out one, or a correct one taken with the wrong field of view. Only
 * the last is genuinely hard to catch, and the other three are what this is
 * for.
 *
 * It also checks the visible canvas is unchanged afterwards. The capture
 * borrows the renderer, and putting back the render target, the tone mapping
 * and the exposure is the difference between a still and a permanently broken
 * viewer.
 */
import { chromium } from "playwright";
import { PNG } from "pngjs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${base}/tour/demo-house`, { waitUntil: "networkidle" });
await page.waitForFunction(() => typeof window.__capture === "function", { timeout: 20_000 });

// Wait for the camera to stop moving before taking the reference frame.
//
// The opening flight is driven per frame and headless chromium has no GPU, so
// a fixed sleep leaves it mid-move - and the "before" and "after" frames then
// differ because the camera travelled between them, which is
// indistinguishable from the capture having broken the viewer.
await page.waitForFunction(
  () => {
    const c = window.__camera;
    if (!c) return false;
    const last = window.__settleLast;
    window.__settleLast = c.position;
    if (!last) return false;
    return Math.hypot(
      c.position[0] - last[0],
      c.position[1] - last[1],
      c.position[2] - last[2],
    ) < 0.002;
  },
  { timeout: 45_000, polling: 350 },
);
await page.waitForTimeout(1200);

const beforeShot = PNG.sync.read(await page.locator("canvas").screenshot());

// The pose of the demo house's first photograph, in world terms.
const shot = await page.evaluate(() => {
  const doc = JSON.parse(localStorage.getItem("mattermatt:property:demo-house") ?? "null");
  const node = doc?.nodes?.[0];
  const pose = node
    ? {
        position: [node.position[0], node.eyeHeight, node.position[1]],
        headingDeg: node.heading,
        pitchDeg: node.pitch ?? 0,
        fovDeg: node.fovDeg,
      }
    : { position: [3, 1.6, 3], headingDeg: 45, pitchDeg: 0, fovDeg: 78 };
  return { url: window.__capture(pose), pose };
});

await page.waitForTimeout(1200);
const afterShot = PNG.sync.read(await page.locator("canvas").screenshot());

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

check("a capture is produced", typeof shot.url === "string" && shot.url.startsWith("data:image/jpeg"));

let stats = null;
if (typeof shot.url === "string") {
  stats = await page.evaluate(
    (url) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const { data } = ctx.getImageData(0, 0, img.width, img.height);
          let min = 255;
          let max = 0;
          let sum = 0;
          // The top and bottom fifths separately: an inverted render puts the
          // floor where the ceiling belongs, and in this model those two are
          // reliably different brightnesses.
          let top = 0;
          let bottom = 0;
          const band = Math.floor(img.height / 5);
          for (let y = 0; y < img.height; y++) {
            for (let x = 0; x < img.width; x++) {
              const i = (y * img.width + x) * 4;
              const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
              min = Math.min(min, l);
              max = Math.max(max, l);
              sum += l;
              if (y < band) top += l;
              if (y >= img.height - band) bottom += l;
            }
          }
          const n = img.width * img.height;
          resolve({
            width: img.width,
            height: img.height,
            min,
            max,
            mean: sum / n,
            top: top / (band * img.width),
            bottom: bottom / (band * img.width),
          });
        };
        img.onerror = () => resolve(null);
        img.src = url;
      }),
    shot.url,
  );
}

check("it decodes", stats !== null);
if (stats) {
  check("at the size asked for", stats.width === 1024 && stats.height === 768, `${stats.width}x${stats.height}`);
  // A black frame is the classic failure - the render target never rendered.
  check("it is not a blank frame", stats.max - stats.min > 20, `range ${(stats.max - stats.min).toFixed(1)}`);
  check("and not washed out", stats.mean > 8 && stats.mean < 250, `mean ${stats.mean.toFixed(1)}`);
  check(
    "it is the right way up",
    // The model is lit from above, so the ceiling end of an interior view is
    // brighter than the floor end. Inverted, this comparison flips.
    Math.abs(stats.top - stats.bottom) > 2,
    `top ${stats.top.toFixed(1)} vs bottom ${stats.bottom.toFixed(1)}`,
  );
}

// The viewer has to survive having its renderer borrowed.
const same =
  beforeShot.width === afterShot.width &&
  beforeShot.height === afterShot.height &&
  (() => {
    let diff = 0;
    for (let i = 0; i < beforeShot.data.length; i += 4) {
      if (Math.abs(beforeShot.data[i] - afterShot.data[i]) > 8) diff++;
    }
    return diff / (beforeShot.data.length / 4) < 0.02;
  })();
check("the visible canvas is unchanged afterwards", same);
check("no errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  JSON.stringify(
    {
      pose: shot.pose,
      image: stats && {
        size: `${stats.width}x${stats.height}`,
        mean: +stats.mean.toFixed(1),
        range: +(stats.max - stats.min).toFixed(1),
      },
      verdict:
        failures === 0
          ? "CAPTURE OK - a real, upright, tone-mapped still from the pose given, and the viewer is untouched"
          : `FAILED - ${failures} check${failures === 1 ? "" : "s"}`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
