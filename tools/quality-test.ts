/**
 * The quality tiers say something, and a CPU pretending to be a GPU never
 * gets the top one.
 */
import { TIERS, detectQuality, isSoftwareRenderer, steppedQuality } from "../src/lib/render/quality";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

check("each tier costs at least what the one below it does",
  TIERS.low.shadowSize <= TIERS.medium.shadowSize && TIERS.medium.shadowSize < TIERS.high.shadowSize &&
  TIERS.low.dpr <= TIERS.medium.dpr && TIERS.medium.dpr <= TIERS.high.dpr);
check("the top tier is not the middle one under another name",
  JSON.stringify(TIERS.high) !== JSON.stringify(TIERS.medium));
check("only the top tier softens shadows and focuses a lens",
  TIERS.high.softShadows && TIERS.high.depthOfField && !TIERS.medium.softShadows && !TIERS.medium.depthOfField && !TIERS.low.softShadows);
check("the bottom tier keeps the frame cheap",
  TIERS.low.occlusion === "none" && !TIERS.low.bloom && !TIERS.low.assets);
check("the middle tier still has contact shadow", TIERS.medium.occlusion === "half");

check("a dropped frame rate steps one tier down", steppedQuality("high", -1, "high") === "medium" && steppedQuality("medium", -1, "high") === "low");
check("and no further than the bottom", steppedQuality("low", -1, "high") === "low");
check("recovery climbs back, but not past what was detected", steppedQuality("low", 1, "medium") === "medium" && steppedQuality("medium", 1, "medium") === "medium");

check("SwiftShader is software", isSoftwareRenderer("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)"));
check("llvmpipe is software", isSoftwareRenderer("Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits)"));
check("a real GPU is not", !isSoftwareRenderer("ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)") && !isSoftwareRenderer(null));

// A desktop, as far as the heuristic can tell: many cores, plenty of memory,
// no window. Node's own navigator has the cores and not the memory, so it
// is stood in for.
Object.defineProperty(globalThis, "navigator", {
  value: { hardwareConcurrency: 10, deviceMemory: 8 },
  configurable: true,
});
check("many cores on a real GPU is the top tier", detectQuality("Apple M2 Pro") === "high", detectQuality("Apple M2 Pro"));
check("many cores on a software renderer is the bottom tier", detectQuality("SwiftShader") === "low", detectQuality("SwiftShader"));
Object.defineProperty(globalThis, "navigator", { value: { hardwareConcurrency: 4, deviceMemory: 8 }, configurable: true });
check("few cores is the middle tier whatever draws", detectQuality("Apple M2 Pro") === "medium");

console.log(failures === 0 ? "QUALITY OK - three tiers that differ, and software never gets the top one" : `QUALITY BROKEN - ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
