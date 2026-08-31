/**
 * One room at a time: looked at, walked into, and costed on its own.
 *
 * The costing is the half that matters. A camera framed slightly wrong still
 * shows a house and a walker dropped a foot off still walks, but a room headed
 * by the house's total is a number somebody would quote - and it would look
 * entirely plausible, because it is a real figure about a real property. So the
 * checks here compare the room's headline against the house's and refuse to let
 * them be the same.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

// A house with something to spend money on, in rooms and on the roof both, so
// a room total and a house total cannot coincide by accident.
await page.goto(`${BASE}/tour/demo-house`, { waitUntil: "networkidle" });
await page.evaluate(async () => {
  const raw = await fetch("/properties/demo-house/property.json").then((r) => r.json());
  raw.condition = {
    living: { floor: "poor", walls: "dated" },
    kitchen: { floor: "poor", cabinets: "poor", counters: "dated" },
    bath: { floor: "dated", tile: "poor" },
    bedroom: { floor: "poor" },
  };
  raw.houseCondition = { roof: "poor", hvac: "dated" };
  localStorage.setItem("mattermatt:property:demo-house", JSON.stringify(raw));
  localStorage.setItem("mattermatt:index", JSON.stringify(["demo-house"]));
});
await page.goto(`${BASE}/tour/demo-house`, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 25_000 });
await page.waitForTimeout(4500);

const railTotal = () => page.locator("[data-rail-total]").innerText();
const railRoom = () => page.locator("[data-rail-total]").getAttribute("data-room");
const camera = () => page.evaluate(() => window.__camera ?? null);
const walker = () => page.evaluate(() => window.__walk ?? null);
const dollhouse = async () => {
  const b = page.getByRole("button", { name: "Dollhouse" });
  if (await b.isEnabled().catch(() => false)) {
    await b.click();
    await page.waitForTimeout(300);
  }
};

// --- Nothing focused: the whole house, as before ---
const houseTotal = await railTotal();
check("the house total is shown before anything is clicked", /\$[\d,]+/.test(houseTotal), houseTotal);
check("no room is focused yet", (await railRoom()) === null);
check("the whole-house block is in the tree", (await page.locator("[data-house-block]").count()) === 1);
const beforeCamera = await camera();
check("the camera reports itself", Boolean(beforeCamera));

// --- Click a room ---
const box = await page.locator("canvas").boundingBox();
let focused = null;
for (let y = 300; y <= 700 && !focused; y += 40) {
  for (let x = Math.round(box.x + 120); x < box.x + box.width - 120; x += 70) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(110);
    // A ring click steps into a photograph; come back so this is judging the
    // dollhouse rather than a node view.
    await dollhouse();
    const room = await railRoom();
    if (room) {
      focused = { x, y, room };
      break;
    }
  }
}
check("clicking a room focuses it", Boolean(focused), "nothing was ever focused");

if (!focused) {
  console.log(JSON.stringify({ errors, verdict: "BROKEN - no room could be focused" }, null, 2));
  await browser.close();
  process.exit(1);
}

await page.waitForTimeout(1400);

// --- The scope is that room, and only that room ---
const roomTotal = await railTotal();
check("the headline is no longer the house total", roomTotal !== houseTotal, `${roomTotal} vs ${houseTotal}`);
check(
  "the tree footer is the room's, not the house's",
  (await page.locator("[data-tree-total]").getAttribute("data-room")) === focused.room,
);
check(
  "the whole-house block is gone - roof and systems belong to no room",
  (await page.locator("[data-house-block]").count()) === 0,
);
check(
  "the headline and the tree footer agree",
  (await page.locator("[data-tree-total]").innerText()).includes(roomTotal.trim()),
  `${roomTotal} not in the footer`,
);
const rows = await page.locator("[data-room-row]").count();
check("only that room is listed", rows === 1, `${rows} rooms listed`);

// --- The camera went to it ---
const afterCamera = await camera();
const moved = Math.hypot(
  afterCamera.position[0] - beforeCamera.position[0],
  afterCamera.position[1] - beforeCamera.position[1],
  afterCamera.position[2] - beforeCamera.position[2],
);
check("the camera moved to the room", moved > 0.5, `${moved.toFixed(2)}m`);
check("and is looking at it", afterCamera.focusRoomId === focused.room, `${afterCamera.focusRoomId}`);

// --- And back out again ---
await page.locator("[data-whole-house]").click();
await page.waitForTimeout(900);
check("'Whole house' restores the house total", (await railTotal()) === houseTotal, await railTotal());
check("and the whole-house block", (await page.locator("[data-house-block]").count()) === 1);
check("and every room", (await page.locator("[data-room-row]").count()) > 1);

// --- Escape lets go too ---
await page.mouse.click(focused.x, focused.y);
await dollhouse();
await page.waitForTimeout(400);
if (await railRoom()) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  check("Escape lets go of the room", (await railRoom()) === null, `${await railRoom()}`);
}

// --- Double click walks in ---
await page.mouse.click(focused.x, focused.y);
await dollhouse();
await page.waitForTimeout(1600);
const walkRoom = await railRoom();

// Re-aim. The camera has flown in, so the pixel that worked before may now be
// sky - and the canvas fills the window, so asking what element is under the
// pointer always answers "the canvas". Clicking past the house clears the
// focus, which is exactly the signal needed: a point that leaves a room costed
// is a point that landed on one.
let target = null;
const candidates = [
  [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)],
];
for (let y = 320; y <= 700; y += 60) {
  for (let x = Math.round(box.x + 200); x < box.x + box.width - 200; x += 90) {
    candidates.push([x, y]);
  }
}
for (const [x, y] of candidates) {
  await page.mouse.click(x, y);
  await page.waitForTimeout(140);
  await dollhouse();
  if (await railRoom()) {
    target = { x, y };
    break;
  }
  // Missed, so the focus is gone. Put it back and try elsewhere.
  await page.mouse.click(focused.x, focused.y);
  await dollhouse();
  await page.waitForTimeout(140);
}
check("a point on the focused house could be found to double click", Boolean(target));
if (!target) target = { x: focused.x, y: focused.y };
await page.waitForTimeout(1200);
await page.mouse.dblclick(target.x, target.y);
await page.waitForTimeout(2600);

const walk = await walker();
check("double click puts you on foot", Boolean(walk), "no walker state");
if (walk) {
  const room = await page.evaluate((id) => {
    const doc = JSON.parse(localStorage.getItem("mattermatt:property:demo-house"));
    return doc.plan.rooms.find((r) => r.id === id) ?? null;
  }, (await railRoom()) ?? walkRoom);
  if (room) {
    const xs = room.polygon.map((p) => p[0]);
    const ys = room.polygon.map((p) => p[1]);
    check(
      "the walker is standing in the room the rail is costing",
      walk.x >= Math.min(...xs) && walk.x <= Math.max(...xs) &&
        walk.y >= Math.min(...ys) && walk.y <= Math.max(...ys),
      `walker at ${walk.x.toFixed(1)},${walk.y.toFixed(1)} for ${room.label}`,
    );
  }
  check("the scope follows you on foot", Boolean(await railRoom()), "no room costed while walking");
}

// --- Upstairs, where the storey has to be seeded ------------------------
//
// The walker's storey lives inside the scene and never resets, so dropping into
// an upstairs room without saying so would stand somebody on the floor below's
// geometry - at the right x and y, in the wrong building.
await page.goto(`${BASE}/tour/two-storey`, { waitUntil: "networkidle" });
await page.evaluate(async () => {
  const raw = await fetch("/properties/two-storey/property.json").then((r) => r.json());
  localStorage.setItem("mattermatt:property:two-storey", JSON.stringify(raw));
  localStorage.setItem("mattermatt:index", JSON.stringify(["two-storey"]));
});
await page.goto(`${BASE}/tour/two-storey`, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 25_000 });
await page.waitForTimeout(4500);

const upper = page.getByRole("button", { name: "Upper" });
if (await upper.count()) {
  await upper.click();
  await page.waitForTimeout(600);
}

const box2 = await page.locator("canvas").boundingBox();
let up = null;
for (let y = 280; y <= 700 && !up; y += 45) {
  for (let x = Math.round(box2.x + 160); x < box2.x + box2.width - 160; x += 75) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(120);
    await dollhouse();
    const r = await railRoom();
    if (r && r.startsWith("u_")) {
      up = { x, y, room: r };
      break;
    }
  }
}
check("an upstairs room can be focused", Boolean(up), "none found");

if (up) {
  // Let go first, so the camera returns to where the sweep found this pixel,
  // and then make the gesture a person makes: two clicks in quick succession,
  // with no pause for the camera to move between them.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1400);
  await page.mouse.dblclick(up.x, up.y);
  await page.waitForTimeout(2600);

  const upstairsWalk = await walker();
  check("double clicking upstairs lands upstairs", upstairsWalk?.level === 1, `level ${upstairsWalk?.level}`);
  check(
    "and at that storey's height, not the one below",
    (upstairsWalk?.eye ?? 0) > 3,
    `eye ${upstairsWalk?.eye}`,
  );
  check("and the rail follows", (await railRoom())?.startsWith("u_") === true, `${await railRoom()}`);
}

check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  JSON.stringify(
    {
      houseTotal,
      focusedRoom: focused.room,
      roomTotal,
      cameraMoved: Number(moved.toFixed(2)),
      walker: walk ? { x: Number(walk.x.toFixed(2)), y: Number(walk.y.toFixed(2)) } : null,
      upstairs: up?.room ?? null,
      errors,
      verdict:
        failures === 0
          ? `ROOM FOCUS OK - ${focused.room} costs ${roomTotal} on its own, against ${houseTotal} for the house`
          : `BROKEN - ${failures} check(s) failed`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
