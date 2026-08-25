/**
 * Does pose estimation find where a photo was taken from?
 *
 * Uses the synthetic demo house, which is the one fixture with exact ground
 * truth: every camera in it was placed by `make_demo_assets.py` at a known
 * position and heading, so the answer can be scored rather than eyeballed.
 *
 * Those rooms are also visually bare, which cuts both ways — there is little to
 * recognise, but the wall geometry is unusually clean, and wall geometry is
 * precisely what this reads.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const property = JSON.parse(
  readFileSync("public/properties/demo-house/property.json", "utf8"),
);

const M_PER_FT = 0.3048;
const bounds = (polygon) => {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

const dir = "public/properties/demo-house/photos";
const files = Object.fromEntries(readdirSync(dir).map((f) => [f, join(dir, f)]));

const photos = property.nodes.map((node) => {
  const room = property.plan.rooms.find((r) => r.id === node.roomId);
  const b = bounds(room.polygon);
  const stem = node.photo.split("/").pop();
  const walls = new Set();
  for (const o of property.plan.openings) {
    if (!o.between.includes(room.id)) continue;
    if (Math.abs(o.at[1] - b.y0) < 0.2) walls.add("north");
    else if (Math.abs(o.at[1] - b.y1) < 0.2) walls.add("south");
    else if (Math.abs(o.at[0] - b.x0) < 0.2) walls.add("west");
    else if (Math.abs(o.at[0] - b.x1) < 0.2) walls.add("east");
  }
  return {
    id: node.id,
    dataUrl: "data:image/jpeg;base64," + readFileSync(files[stem]).toString("base64"),
    room: room.label,
    widthFt: (b.x1 - b.x0) / M_PER_FT,
    depthFt: (b.y1 - b.y0) / M_PER_FT,
    doorways: [...walls],
    truth: { node, room, b },
  };
});

const status = await fetch(`${base}/api/pose`).then((r) => r.json());
if (!status.available) {
  console.log(JSON.stringify({ verdict: "SKIPPED - no ANTHROPIC_API_KEY" }, null, 2));
  process.exit(0);
}

const compassToPlan = (deg) => (((180 - deg) % 360) + 360) % 360;
const angleGap = (a, b) => {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
};

const results = [];
for (let i = 0; i < photos.length; i += 4) {
  const batch = photos.slice(i, i + 4);
  const response = await fetch(`${base}/api/pose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      photos: batch.map(({ truth, ...p }) => p),
    }),
  });
  const data = await response.json();
  for (const pose of data.poses ?? []) {
    const source = batch.find((p) => p.id === pose.id);
    const { node, b } = source.truth;
    const gotPos = [
      b.x0 + (b.x1 - b.x0) * pose.u,
      b.y0 + (b.y1 - b.y0) * pose.v,
    ];
    const roomSize = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
    results.push({
      id: pose.id,
      room: source.room,
      confidence: pose.confidence,
      headingErrorDeg: Math.round(angleGap(compassToPlan(pose.headingDeg), node.heading)),
      positionErrorPct: Math.round(
        (Math.hypot(gotPos[0] - node.position[0], gotPos[1] - node.position[1]) / roomSize) * 100,
      ),
    });
  }
}

const confident = results.filter((r) => r.confidence === "high");
const facingRight = (r) => r.headingErrorDeg <= 60;
const confidentOk = confident.filter(facingRight).length;
const allOk = results.filter(facingRight).length;

console.log(
  JSON.stringify(
    {
      results,
      summary: {
        total: results.length,
        confident: confident.length,
        facingRoughlyRight: `${allOk}/${results.length}`,
        confidentAndRight: confident.length ? `${confidentOk}/${confident.length}` : "n/a",
        medianHeadingError:
          results.map((r) => r.headingErrorDeg).sort((a, b) => a - b)[
            Math.floor(results.length / 2)
          ] + "°",
      },
      // The claim under test is the contract, not the accuracy: a pose the model
      // calls confident should not be pointing at the wrong wall, because a
      // confident wrong answer overrides a heuristic that was probably right.
      verdict:
        confident.length === 0
          ? "NO CONFIDENT POSES - every photo kept its heuristic placement, which is the safe outcome"
          : confidentOk === confident.length
            ? `POSE OK - all ${confident.length} confident poses face roughly the right way`
            : `POSE UNRELIABLE - ${confident.length - confidentOk} confident poses face the wrong way`,
    },
    null,
    2,
  ),
);
