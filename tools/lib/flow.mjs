/**
 * The wizard's happy path, in one place.
 *
 * Six suites drove the old five-step flow by clicking "Next" and assuming where
 * they landed. Collapsing it to one button broke all six at once, which is a
 * fair signal that each of them knew more about the UI than it needed to.
 */

/** Clear any draft left by an earlier run, which would mask what is being tested. */
export async function freshStart(page, base) {
  await page.goto(`${base}/new`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  if (await page.getByRole("button", { name: "Start over" }).count()) {
    await page.getByRole("button", { name: "Start over" }).click();
    await page.waitForTimeout(500);
  }
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
 * Press the one button and wait for the house.
 *
 * Generous, because this really does run classification, layout, pose
 * estimation and the first depth maps end to end.
 */
export async function build(page, { timeoutMs = 200_000 } = {}) {
  await page.getByRole("button", { name: "Build my tour" }).click();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    const there = await page.evaluate(() => /Here is your house/.test(document.body.innerText));
    if (there) return true;
  }
  return false;
}

/** The saved property document, which is what the app actually recorded. */
export async function savedProperty(page) {
  return page.evaluate(() => {
    const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
    const id = index[index.length - 1];
    const doc = JSON.parse(localStorage.getItem("mattermatt:property:" + id) ?? "null");
    return doc ? { ...doc, _id: id } : null;
  });
}

/** Room labels the draft recorded per photo, keyed by file name. */
export async function draftLabels(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("mattermatt");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const draft = await new Promise((resolve) => {
      const tx = db.transaction("docs", "readonly");
      const request = tx.objectStore("docs").get("draft");
      request.onsuccess = () => resolve(request.result ?? null);
    });
    const out = {};
    for (const photo of draft?.photos ?? []) out[photo.name] = photo.roomLabel;
    return out;
  });
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
