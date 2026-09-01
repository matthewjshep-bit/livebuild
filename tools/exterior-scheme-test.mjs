/**
 * A house wearing its own colours.
 *
 * The building's exterior is read from OpenStreetMap's tags, which mappers fill
 * in and which this app fetched and threw away on every lookup. Where they say
 * the walls are brick at #6c5d4f, the model should be that colour rather than
 * one of four canned directions - which is the difference between "a house" and
 * "this house", and the whole point of the exercise.
 *
 * Two halves. A house that was surveyed offers its own colours and picks them
 * by default; a house that was not is left exactly as it always was, with the
 * same four schemes and the same default. The second half matters as much: most
 * buildings have no such tags, and they must not end up with an empty scheme.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const seed = async (id, exterior) => {
  await page.goto(`${BASE}/editor`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ id, exterior }) => {
      const property = {
        id,
        label: "Exterior Fixture",
        displayUnits: "ft",
        plan: {
          scaleRef: { px: 1, meters: 0.3048 },
          rooms: [
            {
              id: "r1",
              label: "Living Room",
              polygon: [[0, 0], [5, 0], [5, 4], [0, 4]],
              ceilingHeight: 2.7,
              level: 0,
            },
          ],
          openings: [],
        },
        nodes: [],
        splats: [],
        condition: {},
        houseCondition: {},
        rates: {},
        exterior,
      };
      localStorage.setItem("mattermatt:property:" + id, JSON.stringify(property));
      const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
      if (!index.includes(id)) index.push(id);
      localStorage.setItem("mattermatt:index", JSON.stringify(index));
    },
    { id, exterior },
  );
  await page.goto(`${BASE}/tour/${id}`, { waitUntil: "networkidle" });
  await page.waitForSelector("select[aria-label='Interior scheme']", { timeout: 20_000 });
  await page.waitForTimeout(1500);
};

const schemeState = () =>
  page.evaluate(() => {
    const select = document.querySelector("select[aria-label='Interior scheme']");
    return {
      options: [...select.options].map((o) => o.value),
      selected: select.value,
    };
  });

// --- A surveyed house, brick at a real hex ---
await seed(`ext-yes-${Date.now().toString(36)}`, {
  storeys: 2,
  roof: { shape: "hip", ridgeBearing: null, pitchDeg: null, material: null, colour: "grey" },
  walls: { material: "brick", colour: "#6c5d4f" },
  frontDoorBearing: 180,
  garage: null,
  source: "map",
  imageryDate: null,
  confidence: "high",
  attribution: ["Building outline © OpenStreetMap contributors (ODbL)"],
});

const surveyed = await schemeState();
check("the house's own colours are offered", surveyed.options.includes("This house"), surveyed.options.join(", "));
check("they come first", surveyed.options[0] === "This house", surveyed.options[0]);
check("and are chosen by default", surveyed.selected === "This house", surveyed.selected);
check("the canned directions are still there", surveyed.options.length === 5, `${surveyed.options.length}`);

// Switching away and back must work, since the list is per-property.
await page.selectOption("select[aria-label='Interior scheme']", "Warm minimal");
await page.waitForTimeout(600);
check("a canned scheme can still be chosen", (await schemeState()).selected === "Warm minimal");

// --- A house nobody tagged is untouched ---
await seed(`ext-no-${Date.now().toString(36)}`, null);
const plain = await schemeState();
check("an untagged house offers only the canned schemes", plain.options.length === 4, `${plain.options.length}`);
check("'This house' is not offered", !plain.options.includes("This house"));
check("the old default still wins", plain.selected === "Cool contemporary", plain.selected);

check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  JSON.stringify(
    {
      surveyed,
      plain,
      errors,
      verdict:
        failures === 0
          ? "EXTERIOR SCHEME OK - a surveyed house wears its own colours by default; an untagged one is unchanged"
          : `BROKEN - ${failures} check(s) failed`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
