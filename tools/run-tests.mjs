/**
 * Run the suites.
 *
 * There are eighty-odd verification scripts in here and, until this existed, no
 * way to run them but by name, one at a time, from a list in the README that
 * had drifted to a third of them. So nobody ran them: four suites were failing
 * on `main` at once, each for its own reason, and each had been failing since
 * whichever change broke it. A suite nobody can run in one command reports
 * nothing.
 *
 * Two halves, because they cost different things:
 *
 *   npm test              the pure ones - no browser, no network, about a minute
 *   npm run test:browser  the real-browser ones - needs `npm run dev` up
 *   npm run test:all      both
 *
 * The pure half is the one to wire into anything automatic. It is hermetic:
 * every URL in it is a string being parsed, not a host being called.
 *
 * Every suite gets a deadline. `address-test` sat for 220 seconds waiting for a
 * screen that was never coming, and a hung run is worse than a failed one - it
 * gets killed by whoever is watching, and then nobody knows what passed.
 *
 * Pass a substring to narrow it: `npm test -- plan` runs everything matching.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(TOOLS);

/** Pure suites run under tsx; browser suites are plain node driving playwright. */
const KINDS = {
  node: { suffix: "-test.ts", command: (f) => ["npx", ["tsx", f]], timeoutMs: 120_000, lanes: 4 },
  browser: { suffix: "-test.mjs", command: (f) => ["node", [f]], timeoutMs: 300_000, lanes: 1 },
};

const argv = process.argv.slice(2);
const want = argv.includes("--browser")
  ? ["browser"]
  : argv.includes("--all")
    ? ["node", "browser"]
    : ["node"];
const filter = argv.find((a) => !a.startsWith("--")) ?? "";

function suitesFor(kind) {
  return readdirSync(TOOLS)
    .filter((f) => f.endsWith(KINDS[kind].suffix))
    .filter((f) => f.includes(filter))
    .sort()
    .map((f) => join("tools", f));
}

/**
 * One suite, killed rather than waited on if it stops making progress.
 *
 * `detached` and a negative pid are the whole of it. `npx tsx x.ts` is npx
 * spawning node, so killing the child kills the launcher and leaves the suite
 * running with the pipes still open - `close` never fires, and the deadline
 * that was supposed to stop a hang hangs instead. Killing the process group
 * takes the grandchild with it.
 */
function run(kind, file) {
  const { command, timeoutMs } = KINDS[kind];
  const [bin, args] = command(file);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(bin, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone between the deadline and the signal.
      }
    }, timeoutMs);

    const finish = (code) => {
      clearTimeout(timer);
      resolve({
        file,
        ok: code === 0 && !timedOut,
        timedOut,
        seconds: Math.round((Date.now() - started) / 1000),
        output,
      });
    };
    child.on("close", finish);
    child.on("error", (error) => {
      output += String(error);
      finish(1);
    });
  });
}

/** As many at once as the kind allows, keeping every lane busy. */
async function runAll(kind, files) {
  const queue = [...files];
  const results = [];
  const lane = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const result = await run(kind, next);
      results.push(result);
      const mark = result.ok ? "ok  " : result.timedOut ? "TIME" : "FAIL";
      process.stdout.write(`  ${mark}  ${String(result.seconds).padStart(3)}s  ${result.file}\n`);
    }
  };
  await Promise.all(Array.from({ length: KINDS[kind].lanes }, lane));
  return results;
}

const failures = [];
for (const kind of want) {
  const files = suitesFor(kind);
  if (files.length === 0) continue;
  console.log(`\n${kind === "node" ? "Pure suites" : "Browser suites"} (${files.length})\n`);
  const results = await runAll(kind, files);
  failures.push(...results.filter((r) => !r.ok));
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failed:\n`);
  for (const f of failures) {
    console.log(`--- ${f.file}${f.timedOut ? " (timed out)" : ""}`);
    // The tail, because these print their verdict last. The whole log of a
    // suite that crashed on line one is still only a few lines.
    console.log(
      f.output.trim().split("\n").slice(-12).map((l) => `    ${l}`).join("\n"),
    );
  }
}

const total = failures.length;
console.log(total === 0 ? "\nAll suites passed.\n" : `\n${total} suite(s) failed.\n`);
process.exit(total === 0 ? 0 : 1);
