/** Dragging turns the head the way a person expects, and stops where a neck does. */
import { PITCH_LIMIT, damped, headingVector, turnBy, yawTowards } from "../src/lib/model/look";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const start = { yaw: 0, pitch: 0 };
const right = turnBy(start, 200, 0);
check("dragging right looks right", right.yaw < 0, `${right.yaw}`);
const down = turnBy(start, 0, 200);
check("dragging down looks down", down.pitch < 0, `${down.pitch}`);
const far = turnBy(start, 0, -100000);
check("but never past straight up", far.pitch === PITCH_LIMIT, `${far.pitch}`);
check("nor straight down", turnBy(start, 0, 100000).pitch === -PITCH_LIMIT);
check("a released turn dies away", damped(1, 1) < 0.01 && damped(1, 0) === 1 && damped(1, 5) === 0);
const h = headingVector(0);
check("facing yaw 0 is +y in plan", Math.abs(h[0]) < 1e-9 && Math.abs(h[1] - 1) < 1e-9);
check("turning to face a spot", Math.abs(yawTowards([0, 0], [1, 0]) - Math.PI / 2) < 1e-9);

console.log(failures === 0 ? "WALK LOOK OK - a drag turns the head the expected way, the pitch stops at the limits, and a released turn dies away" : `WALK LOOK BROKEN - ${failures}`);
process.exit(failures === 0 ? 0 : 1);
