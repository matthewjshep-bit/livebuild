/**
 * The rendered model is what opens, and it renders.
 *
 * Screenshots are the real judge of a model, and no assertion covers "does this
 * look like a house". What can be checked is that it renders at all, on both a
 * single-storey and a stacked plan, with no console errors — and that the
 * photographic layer still works underneath it, since demoting the photos was
 * meant to keep them, not break them.
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3000";

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text().slice(0, 140));
});

const results = {};

for (const [name, route] of [
  ["single storey", "/tour/demo-house"],
  ["two storey", "/tour/two-storey"],
]) {
  await page.goto(base + route, { waitUntil: "networkidle" });
  await page.waitForTimeout(4500);
  await page.screenshot({ path: `shots/model-${name.replace(/\s+/g, "-")}.png` });

  results[name] = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const ctx = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    return {
      rendered: !!canvas && canvas.width > 0,
      // Room labels are drawn as HTML over the canvas, so their presence means
      // the model laid out far enough to place them.
      labels: [...document.querySelectorAll("div")]
        .map((d) => d.textContent ?? "")
        .filter((t) => /sq ft$/.test(t.trim())).length,
      lost: !ctx || ctx.isContextLost(),
    };
  });
}

// The photographic layer must still be reachable.
await page.goto(`${base}/tour/demo-house?node=n1`, { waitUntil: "networkidle" });
await page.waitForTimeout(4500);
await page.screenshot({ path: "shots/model-inside-photo.png" });
const photoLayer = await page.evaluate(() => !!document.querySelector("canvas"));

const ok =
  Object.values(results).every((r) => r.rendered && r.labels > 0 && !r.lost) &&
  photoLayer &&
  errors.length === 0;

console.log(
  JSON.stringify(
    {
      results,
      photoLayerStillWorks: photoLayer,
      errors: errors.slice(0, 4),
      verdict: ok
        ? "MODEL OK - renders on both plans with room labels, and the photo layer still works"
        : `FAILED - ${JSON.stringify(results)} photos=${photoLayer} errors=${errors.length}`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(ok ? 0 : 1);
