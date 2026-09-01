/**
 * The wizard's happy path, in one place.
 *
 * Six suites drove the old five-step flow by clicking "Next" and assuming where
 * they landed. Collapsing it to one button broke all six at once, which is a
 * fair signal that each of them knew more about the UI than it needed to.
 */

/**
 * Open the wizard on a clean tour.
 *
 * This used to have to dismiss a resume prompt, because a finished build left a
 * draft behind and `/new` would not go past it. There is no prompt now - `/new`
 * with no id is always a new tour - so this is a navigation, kept as a helper
 * because six suites call it and the guarantee it makes is still worth naming.
 */
export async function freshStart(page, base) {
  await page.goto(`${base}/new`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
}

export async function addPhotos(page, files) {
  await page.setInputFiles('input[type="file"]', files);
  // Photos are written to storage on drop, which takes a moment for a full set.
  await page.waitForTimeout(400 + files.length * 300);
}

/** Optional: open the collapsed description and let it be read. */
export async function describe(page, text) {
  const summary = page.locator("summary", { hasText: "Describe the house" });
  if ((await summary.count()) === 0) return false;
  await summary.click();
  await page.waitForTimeout(300);
  await page.locator("textarea").fill(text);
  await page.getByRole("button", { name: "Read it" }).click();
  await page.waitForTimeout(9000);
  return true;
}

/**
 * Get through the layout stage.
 *
 * The build stops to be drawn now, and the canvas opens empty on purpose - so
 * every test that just wants a house has to say how it wants the layout made.
 * "suggested" presses the button that fills the canvas with what the packer
 * would have done, which is exactly the arrangement these tests used to get for
 * free, so their assertions keep meaning what they meant.
 *
 * A test that is about the *drawing* should place rooms itself and then call
 * `finishLayout` rather than this.
 */
export async function drawLayout(page, { timeoutMs = 200_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let arrived = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if (await page.getByTestId("suggest-layout").count()) {
      arrived = true;
      break;
    }
    // The build may have run straight past on an error, or already finished.
    if (await page.evaluate(() => /Here is your house/.test(document.body.innerText))) return true;
  }
  if (!arrived) return false;

  await page.getByTestId("suggest-layout").click();
  // The suggestion is a model call; wait for rooms to actually appear.
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1500);
    const ready = await page.getByTestId("build-from-layout").isEnabled().catch(() => false);
    if (ready) break;
  }
  return finishLayout(page, { timeoutMs: deadline - Date.now() });
}

/** Accept the layout as drawn and wait for the finished house. */
export async function finishLayout(page, { timeoutMs = 200_000 } = {}) {
  await page.getByTestId("build-from-layout").click();
  return waitForHouse(page, { timeoutMs });
}

/**
 * Press the one button, get through the layout, and wait for the house.
 *
 * Generous, because this really does run classification, layout, pose
 * estimation and the interior read end to end.
 */
export async function build(page, { timeoutMs = 200_000 } = {}) {
  await page.getByRole("button", { name: "Build my tour" }).click();
  return drawLayout(page, { timeoutMs });
}

/** The saved property document, which is what the app actually recorded. */
export async function savedProperty(page) {
  return page.evaluate(() => {
    const index = JSON.parse(localStorage.getItem("livebuild:index") ?? "[]");
    const id = index[index.length - 1];
    const doc = JSON.parse(localStorage.getItem("livebuild:property:" + id) ?? "null");
    return doc ? { ...doc, _id: id } : null;
  });
}

/** Room labels the import recorded per photo, keyed by file name. */
export async function intakeLabels(page, propertyId) {
  return page.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("mattermatt");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const intake = await new Promise((resolve) => {
      const tx = db.transaction("docs", "readonly");
      const request = tx.objectStore("docs").get("intake:" + id);
      request.onsuccess = () => resolve(request.result ?? null);
    });
    const out = {};
    for (const photo of intake?.photos ?? []) out[photo.name] = photo.roomLabel;
    return out;
  }, propertyId);
}

/** Wait for the review screen without pressing anything - used after a rebuild. */
export async function waitForHouse(page, { timeoutMs = 200_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    const there = await page.evaluate(() => /Here is your house/.test(document.body.innerText));
    if (there) return true;
  }
  return false;
}
