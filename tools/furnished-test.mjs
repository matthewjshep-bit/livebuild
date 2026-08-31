/**
 * Turning furniture off empties the house without unplumbing it.
 *
 * "Unfurnished" is not "empty". The seller's bed and sofa will not be there on
 * completion and modelling them is modelling somebody's belongings; the bath,
 * the WC and the run of kitchen counter are part of what is being bought and
 * part of what the scope of work prices. So the switch has to remove one and
 * keep the other, and it has to do it in the 2D drawing as well as in the
 * model - a plan that still shows beds after they were switched off in 3D is
 * worse than not having the switch at all.
 *
 * Counted off the scene rather than eyeballed, because "the bed went away" and
 * "the whole room went away" look identical in a thumbnail.
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const settle = async (furnished) => {
  await page.waitForFunction(
    (want) => window.__scene?.furnished === want,
    furnished,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(1500);
  return page.evaluate(() => window.__scene);
};

await page.goto(`${base}/tour/demo-house`, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 20_000 });

// Off is the default: what is being modelled is the building.
const off = await settle(false);
await page.screenshot({ path: "shots/furnished-off.png" });

await page.locator("[data-furnished-toggle]").click();
const on = await settle(true);
await page.screenshot({ path: "shots/furnished-on.png" });

// The 2D drawing has to follow the same rule. It calls the furniture generator
// directly and used to do so with no gate at all.
await page.locator("button", { hasText: /^Plan$/ }).first().click();
await page.waitForTimeout(1500);
const planWithFurniture = await page.locator("svg rect").count();
await page.locator("[data-furnished-toggle]").click();
await page.waitForTimeout(1500);
const planWithout = await page.locator("svg rect").count();

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

check("furniture off is the default", off.furnished === false);
check(
  "turning it on adds geometry",
  on.triangles > off.triangles,
  `${off.triangles} -> ${on.triangles}`,
);
check(
  "and turning it off leaves a house, not an empty box",
  off.triangles > 0 && off.meshes > 0,
  `${off.meshes} meshes, ${off.triangles} triangles`,
);
check(
  "the fixtures survive being unfurnished",
  // The demo house has a bathroom and a kitchen, so their fittings are the
  // difference between "unfurnished" and "stripped". They are staging-flagged
  // geometry that must still be present with furniture off.
  off.meshes >= Math.round(on.meshes * 0.6),
  `${off.meshes} of ${on.meshes} meshes remain`,
);
check(
  "the 2D plan follows the switch too",
  planWithout < planWithFurniture,
  `${planWithFurniture} rects furnished, ${planWithout} unfurnished`,
);
check("no errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  JSON.stringify(
    {
      off: { furnished: off.furnished, meshes: off.meshes, triangles: off.triangles },
      on: { furnished: on.furnished, meshes: on.meshes, triangles: on.triangles },
      plan: { furnished: planWithFurniture, unfurnished: planWithout },
      verdict:
        failures === 0
          ? "FURNITURE TOGGLE OK - staging comes and goes, the fixtures and the building stay, and the drawing agrees with the model"
          : `FAILED - ${failures} check${failures === 1 ? "" : "s"}`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
