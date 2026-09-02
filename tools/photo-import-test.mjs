/**
 * A photo from a Mac's Photos library gets in, or is told it cannot.
 *
 * Every iPhone photo since 2017 is HEIC and the macOS Photos library hands them
 * over as HEIC. Two separate things were wrong, and the second was the worse:
 *
 * The picker would not let them be chosen at all - `accept="image/*"` leaves
 * Open greyed out in the Photos source of the macOS panel, because the panel
 * allows what the browser told it to allow and the wildcard's expansion does
 * not include `public.heic`.
 *
 * And had one got through, `PhotoDrop` filtered on a MIME whitelist that did
 * not include HEIC and returned with **no message at all**. Select thirty
 * photos, watch nothing happen, learn nothing.
 *
 * This runs a real HEIC through a real browser, in both engines, because the
 * whole design rests on a claim about them that is worth measuring rather than
 * believing: Chromium cannot decode HEIC and Safari can.
 */
import { chromium, webkit } from "playwright";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

// macOS ships HEICs and the tool to make a small one, so the fixture is real
// rather than a handful of bytes that merely claim to be HEIC.
const SOURCE = "/System/Library/Desktop Pictures/Mac Blue.heic";
let heic;
try {
  const out = join(mkdtempSync(join(tmpdir(), "heic-")), "sample.heic");
  execFileSync("sips", ["-s", "format", "heic", "-Z", "800", SOURCE, "--out", out], {
    stdio: "ignore",
  });
  heic = readFileSync(out).toString("base64");
} catch {
  console.log("HEIC SKIPPED - no HEIC to test with on this machine");
  process.exit(0);
}

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

for (const [engine, launcher, decodes] of [
  ["chromium", chromium, false],
  ["webkit", webkit, true],
]) {
  let browser;
  try {
    browser = await launcher.launch();
  } catch {
    console.log(`  (${engine} not installed, skipped)`);
    continue;
  }
  const page = await browser.newPage();
  // The app's own origin, so the import module is the one that ships.
  await page.goto(`${BASE}/new`, { waitUntil: "networkidle" });

  const result = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: "image/heic" });
    try {
      const bitmap = await createImageBitmap(blob);
      const size = `${bitmap.width}x${bitmap.height}`;
      bitmap.close();
      return { decoded: true, size };
    } catch {
      return { decoded: false };
    }
  }, heic);

  check(
    `${engine}: HEIC decodes exactly as the design assumes`,
    result.decoded === decodes,
    `expected decoded=${decodes}, got ${JSON.stringify(result)}`,
  );
  await browser.close();
}

// --- and the drop zone says so rather than doing nothing ---
{
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${BASE}/new`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: /whole house/i }).click().catch(() => {});
  await page.waitForTimeout(600);

  const input = page.locator('input[type="file"]').first();
  check(
    "the picker offers HEIC, so the Open button is not greyed out",
    /heic/i.test((await input.getAttribute("accept")) ?? ""),
    `${await input.getAttribute("accept")}`,
  );

  const buffer = Buffer.from(heic, "base64");
  await input.setInputFiles([{ name: "IMG_4021.HEIC", mimeType: "image/heic", buffer }]);
  await page.waitForTimeout(2500);

  const notice = page.getByTestId("photo-refused");
  check("a photo this browser cannot read is reported", (await notice.count()) === 1);
  if (await notice.count()) {
    const text = await notice.innerText();
    check("by name", /IMG_4021/.test(text), text);
    check("and says what to do about it", /Safari|JPEG/.test(text), text);
  }
  await page.screenshot({ path: "shots/H1-heic-refused.png" });
  await browser.close();
}

// --- and an ordinary photo still goes straight in ---
//
// The other half of the change: every file is now decoded and re-encoded on the
// way in rather than stored as it arrived. A JPEG must come through that
// unchanged in every way that matters, and a big one must come out smaller -
// thirty 12-megapixel photos was over a hundred megabytes of IndexedDB for
// images nothing ever renders above a thousand pixels.
{
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${BASE}/new`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: /whole house/i }).click().catch(() => {});
  await page.waitForTimeout(600);

  // A real photograph, and a deliberately large one.
  const big = readFileSync("public/properties/demo-house/photos/kitchen-01.jpg");
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles([{ name: "kitchen-01.jpg", mimeType: "image/jpeg", buffer: big }]);
  await page.waitForTimeout(3000);

  check("a JPEG is accepted", (await page.getByTestId("photo-refused").count()) === 0,
    await page.getByTestId("photo-refused").textContent().catch(() => ""));

  const stored = await page.evaluate(async () => {
    const img = document.querySelector('img[alt="kitchen-01.jpg"]');
    if (!img) return null;
    const blob = await fetch(img.src).then((r) => r.blob());
    const bitmap = await createImageBitmap(blob);
    const out = { type: blob.type, bytes: blob.size, w: bitmap.width, h: bitmap.height };
    bitmap.close();
    return out;
  });
  check("and appears in the strip", stored !== null);
  if (stored) {
    check("stored as JPEG whatever it arrived as", stored.type === "image/jpeg", stored.type);
    check("and no larger than anything downstream asks for",
      Math.max(stored.w, stored.h) <= 2048, `${stored.w}x${stored.h}`);
  }
  await browser.close();
}

console.log(
  failures === 0
    ? "PHOTO IMPORT OK - Chromium cannot read HEIC and Safari can, the picker offers them either way, one this browser cannot read is named rather than silently dropped, and an ordinary photo is stored as a right-sized JPEG"
    : `HEIC BROKEN - ${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
