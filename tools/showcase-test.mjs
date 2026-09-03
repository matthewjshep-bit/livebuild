/**
 * The showcase house shows everything the build can now do.
 *
 * `/tour/showcase` is the bundled sample whose data fills every field; this
 * opens it and checks each thing the renderer derives from that data is on
 * screen - the read rooms' cabinets and appliances, the wall skins, the lot,
 * the roads and their names, the neighbours, the house's garage, the garden,
 * the cladding and the roof, "This house" wearing the photographed colours,
 * the Outside panel - and that the Street view stands at its kerb. If a push
 * breaks any of it, this is the suite that says so before the live site does.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${BASE}/tour/showcase`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__scene && window.__scene.meshes > 0, { timeout: 60_000 });
await page.waitForTimeout(3000);
const scene = await page.evaluate(() => window.__scene);
check("the showcase opens at the kerb", scene.mode === "street", scene.mode);
const by = scene.bySurface ?? {};
// No ceilings here: the dollhouse has none by design, or it would be a set
// of closed boxes. They are checked on foot below.
const want = ["floor", "walls", "cabinets", "appliances", "siding", "roof", "ground", "street", "kerb", "neighbour", "outbuilding", "planting", "fence", "porch", "driveway"];
for (const key of want) check(`the showcase draws ${key}`, (by[key] ?? 0) > 0, JSON.stringify(by));
check("many distinct surfaces", scene.distinctMaps >= 8, `${scene.distinctMaps}`);
check("no photograph is on the model", scene.photoTextures === 0, `${scene.photoTextures}`);
check("nothing glows", scene.emissive === 0, `${scene.emissive}`);
check("the house wears its own colours", (await page.evaluate(() => document.querySelector("select[aria-label='Interior scheme']")?.value)) === "This house");
const names = await page.evaluate(() => [...document.querySelectorAll("[data-street-name]")].map((el) => el.textContent?.trim()));
check("the streets are named", names.includes("Maple Street") && names.includes("Oak Avenue"), names.join(", "));
check("the outside panel is there", (await page.locator("[data-exterior-spec]").count()) === 1);
check("the photographs are the evidence", /Built from\s+6\s+photos/i.test(await page.locator("[data-evidence]").innerText().catch(() => "")), (await page.locator("[data-evidence]").innerText().catch(() => "")).slice(0, 60));
check("the lot is called an estimate", (await page.locator("[data-site-attribution]").count()) === 1);
// From the kerb, which is where it opened.
await page.waitForFunction(() => window.__camera?.target?.[1] === 1.2, { timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(4000);
const cam = await page.evaluate(() => window.__camera);
check("the street view stands at eye height", cam !== null && cam.position[1] > 0.8 && cam.position[1] < 3, JSON.stringify(cam));
check("on the road side", cam !== null && cam.position[2] < 0, JSON.stringify(cam));
await page.screenshot({ path: "shots/SC2-showcase-street.png" });

// The dollhouse is a click away, and Exit brings you back to the kerb.
await page.locator("button", { hasText: "Dollhouse" }).click();
await page.waitForFunction(() => window.__scene?.mode === "dollhouse", { timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(4000);
await page.screenshot({ path: "shots/SC1-showcase-dollhouse.png" });
await page.locator("[data-exit-view]").click();
await page.waitForFunction(() => window.__scene?.mode === "street", { timeout: 20_000 }).catch(() => {});
check("Exit returns to the kerb", (await page.evaluate(() => window.__scene?.mode)) === "street");

// And on foot, in the kitchen: the read cabinets under a read wall.
await page.goto(`${BASE}/tour/showcase?room=kitchen`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__scene && window.__scene.mode === "walk", { timeout: 45_000 }).catch(() => {});
await page.waitForTimeout(3000);
const walk = await page.evaluate(() => window.__scene);
check("on foot the kitchen has its cabinets", (walk.bySurface?.cabinets ?? 0) > 0, JSON.stringify(walk.bySurface));
check("and a ceiling over it", (walk.bySurface?.ceiling ?? 0) > 0, JSON.stringify(walk.bySurface));
check("and its appliances", (walk.bySurface?.appliances ?? 0) > 0);
await page.screenshot({ path: "shots/SC3-showcase-kitchen.png" });

check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
console.log(
  failures === 0
    ? `SHOWCASE OK - ${want.length} kinds of thing on screen, ${scene.distinctMaps} distinct surfaces, no photograph on any of them, the street from its kerb and the kitchen on foot`
    : `SHOWCASE BROKEN - ${failures} failure(s)`,
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
