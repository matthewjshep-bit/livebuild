/** A scan tinted to a read colour averages to that colour, whatever it started as. */
import { meanOfPixels, parseHex, srgbToLinear, tintFor } from "../src/lib/model/tint";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

check("hex parses", JSON.stringify(parseHex("#ff8000")) === JSON.stringify([1, 128 / 255, 0]));
check("bad hex is null", parseHex("oak") === null && parseHex(null) === null);
check("no tone is white", JSON.stringify(tintFor([0.4, 0.3, 0.2], null)) === "[1,1,1]");

// A mid-grey scan brought to a warm brown: the multiplier, applied to the
// scan's linear average, gives the tone's linear value.
const mean: [number, number, number] = [0.5, 0.5, 0.5];
const tint = tintFor(mean, "#8b7446");
const target = parseHex("#8b7446")!;
for (let i = 0; i < 3; i++) {
  const got = srgbToLinear(mean[i]) * tint[i];
  check(`channel ${i} lands on the tone`, Math.abs(got - srgbToLinear(target[i])) < 1e-6, `${got} vs ${srgbToLinear(target[i])}`);
}
check("a dark scan tinted pale is clamped, not blown out", tintFor([0.02, 0.02, 0.02], "#ffffff").every((v) => v <= 3));
check("the scan's own colour is a tint of one", tintFor(parseHex("#8b7446")!, "#8b7446").every((v) => Math.abs(v - 1) < 1e-6));

const pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]);
check("the mean of red and blue is purple", JSON.stringify(meanOfPixels(pixels)) === JSON.stringify([0.5, 0, 0.5]));

console.log(failures === 0 ? "TINT OK - a scan tinted to a read colour averages to it" : `TINT BROKEN - ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
