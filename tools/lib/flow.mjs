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
export async function freshStart(page, base, mode = "house") {
  await page.goto(`${base}/new`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await chooseMode(page, mode);
}

/**
 * Answer the first question, which is new.
 *
 * The wizard used to open on the photo screen. It opens on a choice now - a
 * room or a whole house - because everything went through the same
 * house-shaped pipeline before, whatever you actually wanted. Every suite that
 * drives the wizard has to answer it, so it is answered here rather than in
 * each of them.
 */
export async function chooseMode(page, mode = "house") {
  const card = page.getByTestId(mode === "room" ? "mode-room" : "mode-house");
  if ((await card.count()) === 0) return false;
  await card.click();
  await page.waitForTimeout(400);
  return true;
}

export async function addPhotos(page, files) {
  const before = await page.getByTestId("photo-thumb").count();
  await page.setInputFiles('input[type="file"]', files);

  /**
   * Wait for the photographs, not for a number of milliseconds.
   *
   * This slept `400 + 300 per file`, which was enough while a drop was a write
   * to storage and stopped being enough the moment every file started being
   * decoded and re-encoded on the way in. The suites then failed one step
   * later, looking for a button that only appears once there are photos - which
   * is a long way from the thing that was actually not finished yet.
   *
   * The README already draws this lesson about the walk tests: a test that
   * sleeps and hopes passes on a fast machine and fails on a slow one.
   */
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if ((await page.getByTestId("photo-thumb").count()) >= before + files.length) break;
    await page.waitForTimeout(200);
  }
  // A beat for the debounced write to storage that follows the render.
  await page.waitForTimeout(400);
}

/**
 * Say what is in the house.
 *
 * This drove a `<textarea>` and a "Read it" button. Both are gone: the house is
 * described by pressing things now, so what a test needs to say is "three
 * bedrooms and two bathrooms" rather than a sentence about them.
 *
 * Returns false when there is no sheet on screen, the way the old helper did
 * when there was no description box, so a caller that only wants a house built
 * does not have to care.
 */
export async function describe(page, { beds, baths, floors } = {}) {
  const summary = page.getByTestId("sheet-summary");
  if ((await summary.count()) === 0) return false;

  const press = async (label, times) => {
    const button = page.getByRole("button", { name: `One ${times > 0 ? "more" : "fewer"} ${label}` });
    for (let i = 0; i < Math.abs(times); i++) {
      await button.click();
      await page.waitForTimeout(60);
    }
  };

  // The steppers start at three bedrooms and two bathrooms, which is what the
  // sheet assumes for a house nobody has said anything about yet.
  if (typeof beds === "number") await press("bedrooms", beds - 3);
  if (typeof baths === "number") await press("bathrooms", (baths - 2) * 2);
  if (typeof floors === "number") await press("floors", floors - 1);
  await page.waitForTimeout(200);
  return true;
}

/**
 * Draw a house with the pointer, badly, the way a hand does.
 *
 * The layout is drawn before the build now, and for a house it is not optional
 * - so every suite that wants a finished tour has to get through this. Kept
 * here rather than in each of them for the reason the rest of this file exists:
 * a suite about photographs should not know how the pen works.
 *
 * Two bands of rooms, which is enough to be a house rather than a corridor, and
 * exactly as many spaces as there are names to put in them. The names come off
 * the board's own chips, so this always agrees with whatever the house sheet
 * currently says.
 *
 * A house is drawn a floor at a time, so this repeats until the board goes
 * away - the last storey's button starts the build rather than opening another
 * tab.
 */
export async function drawRooms(page, { rooms = Infinity, timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const board = page.getByTestId("drawing-board");
  while ((await board.count()) === 0 && Date.now() < deadline) await page.waitForTimeout(300);
  if ((await board.count()) === 0) return false;

  // Six storeys is far beyond anything the sheet offers; the bound is here so a
  // board that refuses forever fails the suite instead of hanging it.
  for (let storey = 0; storey < 6; storey++) {
    if ((await board.count()) === 0) return true;
    if (!(await drawOneStorey(page, rooms))) return false;
    await page.waitForTimeout(700);
  }
  return (await board.count()) === 0;
}

/** One floor: an outline, some walls, and a name in every space it makes. */
async function drawOneStorey(page, rooms) {
  const board = page.getByTestId("drawing-board");
  const wanted = await page.$$eval(
    '[data-testid="wanted-missing"], [data-testid="wanted-drawn"]',
    (els) => els.map((e) => e.dataset.room).filter(Boolean),
  );
  /**
   * Every room the sheet lists, up to the cap - and the staircase whatever
   * happens. A multi-storey house is refused without one, and rightly: an
   * upstairs with no way up it looks perfectly fine on the plan.
   */
  const stairs = wanted.filter((n) => /stair/i.test(n));
  const rest = wanted.filter((n) => !/stair/i.test(n));
  const names = [...stairs, ...rest].slice(0, Math.min(rooms, wanted.length));
  if (names.length < 2) return false;

  const canvas = await board.boundingBox();

  /**
   * Draw inside the building, not inside the canvas.
   *
   * A person draws within the dashed outline because they can see it. This
   * drew at fractions of the whole canvas, so how big a house it drew depended
   * on how the pad happened to be framed - and when the framing changed to make
   * room for the street names, every suite quietly started drawing a house
   * twice the size of the building and failing on "outside the building".
   *
   * The board publishes where the guide is; with no address there is no guide
   * and the canvas is all there is, which is also what the pad does.
   */
  const guide = await board.getAttribute("data-guide");
  const box = guide
    ? (([x, y, w, h]) => ({
        x: canvas.x + x,
        y: canvas.y + y,
        width: w,
        height: h,
      }))(guide.split(",").map(Number))
    : canvas;
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];

  /** A line drawn the way a hand draws one: in steps, with a wobble. */
  const line = async (from, to, steps = 14) => {
    const [x0, y0] = at(...from);
    const [x1, y1] = at(...to);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const jitter = i === steps ? 0 : Math.sin(i * 2.1) * 1.6;
      await page.mouse.move(x0 + (x1 - x0) * t + jitter, y0 + (y1 - y0) * t + jitter);
    }
    await page.mouse.up();
    await page.waitForTimeout(50);
  };

  const top = Math.ceil(names.length / 2);
  const bottom = names.length - top;
  const L = 0.1;
  const R = 0.9;
  const T = 0.12;
  const M = 0.5;
  const B = 0.88;

  await page.getByRole("button", { name: "Draw walls" }).click();
  // The outline, then the wall across the middle.
  await line([L, T], [R, T]);
  await line([R, T], [R, B]);
  await line([R, B], [L, B]);
  await line([L, B], [L, T]);
  if (bottom > 0) await line([L, M], [R, M]);

  const split = async (count, y0, y1) => {
    for (let i = 1; i < count; i++) {
      const x = L + ((R - L) * i) / count;
      await line([x, y0], [x, y1]);
    }
  };
  await split(top, T, bottom > 0 ? M : B);
  if (bottom > 0) await split(bottom, M, B);

  // Name every space. A drawing with an unnamed one is refused, by design.
  await page.getByRole("button", { name: "Name a room" }).click();
  await page.waitForTimeout(200);
  const centres = [];
  for (let i = 0; i < top; i++) {
    centres.push([L + ((R - L) * (i + 0.5)) / top, (T + (bottom > 0 ? M : B)) / 2]);
  }
  for (let i = 0; i < bottom; i++) {
    centres.push([L + ((R - L) * (i + 0.5)) / bottom, (M + B) / 2]);
  }
  for (let i = 0; i < names.length; i++) {
    const [x, y] = at(...centres[i]);
    await page.mouse.click(x, y);
    await page.waitForTimeout(180);
    if ((await page.getByTestId("naming-card").count()) === 0) return false;
    await page.getByLabel("Room name").fill(names[i]);
    await page.getByRole("button", { name: "Add" }).click();
    await page.waitForTimeout(150);
  }

  await page.getByTestId("read-drawing").click();
  await page.waitForTimeout(600);
  // A refusal leaves the problem on screen and the drawing untouched.
  return (await page.getByTestId("drawing-problem").count()) === 0;
}

/**
 * Get through the layout stage.
 *
 * This used to press "Suggest a layout", because the canvas opened empty. It
 * does not any more: the drawing is done before the build and arrives here
 * already fitted to the building, so pressing suggest would throw away the very
 * thing the suite just drew. Accept what is on the canvas; ask for a suggestion
 * only when nothing landed, which is the recovery path rather than the normal
 * one.
 */
export async function drawLayout(page, { timeoutMs = 200_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let arrived = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if (await page.getByTestId("build-from-layout").count()) {
      arrived = true;
      break;
    }
    // The build may have run straight past on an error, or already finished.
    if (await page.evaluate(() => /Here is your house/.test(document.body.innerText))) return true;
  }
  if (!arrived) return false;

  let ready = await page.getByTestId("build-from-layout").isEnabled().catch(() => false);
  if (!ready && (await page.getByTestId("suggest-layout").count())) {
    await page.getByTestId("suggest-layout").click();
    // The suggestion is a model call; wait for rooms to actually appear.
    for (let i = 0; i < 40 && !ready; i++) {
      await page.waitForTimeout(1500);
      ready = await page.getByTestId("build-from-layout").isEnabled().catch(() => false);
    }
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
export async function build(page, { timeoutMs = 200_000, house, rooms } = {}) {
  // The photo screen now leads to the house sheet rather than straight to a
  // build, because the bedroom count is worth asking for before building.
  const onwards = page.getByTestId("continue-from-photos");
  if ((await onwards.count()) > 0) await onwards.click();
  else await page.getByRole("button", { name: "Build my tour" }).click();
  await page.waitForTimeout(600);

  const sheet = page.getByTestId("build-from-sheet");
  if ((await sheet.count()) > 0) {
    if (house) await describe(page, house);
    await sheet.click();
    await page.waitForTimeout(500);
    // The sheet leads to the pen now, and a house cannot be built without one.
    // Every room the sheet lists gets drawn by default: a room nobody draws is
    // a room the house does not have, so capping this is how a suite quietly
    // ends up with photographs that have nowhere to go.
    if (!(await drawRooms(page, rooms === undefined ? {} : { rooms }))) return false;
  }
  return drawLayout(page, { timeoutMs });
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
