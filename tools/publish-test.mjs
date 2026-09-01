/**
 * Verify publishing against a real Supabase project.
 *
 * The upload path cannot be exercised without one - there is no local stand-in
 * short of running Supabase in Docker - so this is the check to run once
 * `.env.local` is filled in, before trusting the Publish button with a real
 * listing.
 *
 * Builds a small tour, publishes it, then loads the public link in a clean
 * browser context with no local storage at all - which is the only way to prove
 * a viewer can actually see it, rather than the author seeing their own cache.
 *
 *   node tools/publish-test.mjs
 */
import { chromium } from "playwright";
import { addPhotos, build, freshStart } from "./lib/flow.mjs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const base = process.env.BASE_URL ?? "http://localhost:3000";

// Read the admin key the same way the server does.
let adminKey = process.env.LIVEBUILD_ADMIN_KEY ?? "";
if (!adminKey) {
  try {
    const env = readFileSync(".env.local", "utf8");
    adminKey = env.match(/^LIVEBUILD_ADMIN_KEY=(.*)$/m)?.[1]?.trim() ?? "";
  } catch {
    /* no env file */
  }
}

const status = await fetch(`${base}/api/publish/status`).then((r) => r.json());
if (!status.storage) {
  console.log(
    JSON.stringify({
      verdict: "SKIPPED - no Supabase configured. Fill in .env.local and see supabase/README.md",
      status,
    }, null, 2),
  );
  process.exit(0);
}
if (!adminKey) {
  console.log(JSON.stringify({ verdict: "SKIPPED - LIVEBUILD_ADMIN_KEY not found" }, null, 2));
  process.exit(0);
}

const dir = "public/properties/demo-house/photos";
const files = readdirSync(dir).slice(0, 3).map((f) => join(dir, f));
const slug = `test-${Date.now().toString(36)}`;

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

// --- Author context: build and publish ---
const author = await browser.newContext({ viewport: { width: 1280, height: 940 } });
const page = await author.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// The wizard used to be five steps with a Next button between each. It was
// collapsed to a single button long ago and this test was never updated -
// because with no Supabase project it reported SKIPPED and nobody ran it. It
// now drives the same shared flow every other suite uses.
await freshStart(page, base);
await addPhotos(page, files);

const built = await build(page);
if (!built) {
  console.log(JSON.stringify({ verdict: "PUBLISH FAILED - the house never built" }, null, 2));
  await browser.close();
  process.exit(1);
}

// Let depth finish so the published tour carries real depth maps rather than
// flat photographs - which is half of what publishing is for.
for (let i = 0; i < 40; i++) {
  const done = await page.evaluate(() => {
    const index = JSON.parse(localStorage.getItem("livebuild:index") ?? "[]");
    const doc = JSON.parse(localStorage.getItem("livebuild:property:" + index.pop()) ?? "null");
    return doc && doc.nodes.length > 0 && doc.nodes.every((n) => n.depth);
  });
  if (done) break;
  await page.waitForTimeout(4000);
}

const id = await page.evaluate(() =>
  JSON.parse(localStorage.getItem("livebuild:index") ?? "[]").pop(),
);
await page.goto(`${base}/tour/${id}`, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);

await page.getByRole("button", { name: "Publish" }).click();
await page.waitForTimeout(600);

// Addressed by label rather than by position. `input` first-on-page used to be
// the slug field and is now an explode slider - the same brittleness that has
// broken three other suites in this codebase.
await page.getByLabel("Publish passphrase").fill(adminKey);
await page.getByLabel("Link").fill(slug);
await page.getByRole("button", { name: "Publish", exact: true }).last().click();

let published = null;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  published = await page.evaluate(() => {
    // Scoped to the panel. Reading `.text-warn` page-wide picked up the scope
    // rail's "5 not seen" and reported it as a publish failure - the panel is
    // the only thing that knows whether publishing worked.
    const panel = document.querySelector("[data-publish-panel]");
    if (!panel) return null;
    if (/Live\. Anyone with this link/.test(panel.textContent ?? "")) {
      const input = panel.querySelector('[aria-label="Share link"]');
      return { url: input instanceof HTMLInputElement ? input.value : null };
    }
    const warn = panel.querySelector(".text-warn");
    return warn ? { error: warn.textContent } : null;
  });
  if (published) break;
}
await page.screenshot({ path: "shots/80-published.png" });

// --- Viewer context: a stranger opening the link ---
// A fresh context has no IndexedDB and no localStorage, so anything that renders
// must have come from the server.
const viewer = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const viewerPage = await viewer.newPage();
const viewerErrors = [];
viewerPage.on("pageerror", (e) => viewerErrors.push(e.message));

let viewerState = null;
if (published?.url) {
  await viewerPage.goto(published.url, { waitUntil: "networkidle" });
  await viewerPage.waitForTimeout(5000);
  await viewerPage.screenshot({ path: "shots/81-viewer.png" });
  viewerState = await viewerPage.evaluate(() => ({
    hasCanvas: !!document.querySelector("canvas"),
    offersPublish: /Publish/.test(document.body.innerText),
    offersFinish: /still flat/.test(document.body.innerText),
    // The privacy invariant, checked where a published tour actually exists.
    // A visitor is looking at somebody else's listing and has no business
    // seeing what it would cost to renovate it.
    showsScopeRail: !!document.querySelector("[data-scope-rail]"),
    showsCosts: /Scope of work|CONDITION/i.test(document.body.innerText),
    title: document.title,
    localStorageEmpty: localStorage.length === 0,
  }));
}

const ok =
  published?.url &&
  viewerState?.hasCanvas &&
  !viewerState.offersPublish &&
  !viewerState.showsScopeRail &&
  !viewerState.showsCosts &&
  viewerState.localStorageEmpty;

console.log(
  JSON.stringify(
    {
      published,
      viewerState,
      authorErrors: errors.slice(0, 3),
      viewerErrors: viewerErrors.slice(0, 3),
      verdict: ok
        ? `PUBLISH WORKS - ${published.url} renders for a viewer with empty storage, ` +
          `with no author controls and no rehab costs`
        : "PUBLISH FAILED",
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(ok ? 0 : 1);
