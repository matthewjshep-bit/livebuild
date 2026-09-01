import type { RoomSpec } from "@/lib/spec/schema";

/**
 * The rules that keep a correction loop from making things worse.
 *
 * Comparing a render of a room against the photograph it was built from is the
 * only way to close the loop on "exact". It is also the one pass here that can
 * actively destroy work: a model looking at two images will always find
 * *something* to say, and a loop that acts on everything it is told will walk a
 * correct room steadily away from correct, one confident adjustment at a time.
 *
 * So the loop is bounded by arithmetic rather than by good behaviour, and all
 * of it lives here, pure, so it can be tested without an API key, a browser or
 * a single spent request. Five rules:
 *
 * 1. **Nothing but geometry.** A render's white balance is not a photograph's,
 *    so a colour difference between them is almost always the renderer and
 *    almost never the house. Colours come from reading the photograph alone.
 * 2. **A round must earn its keep.** Accepted only if the score improves; if it
 *    does not, the whole round is rolled back. That makes the loop
 *    hill-climbing with rejection, which cannot end below where it started.
 * 3. **A path that oscillates is frozen.** Proposing a value a field has
 *    already held means the loop is arguing with itself, and it stops there.
 * 4. **A person's word is final.** Nothing marked `human` is ever touched.
 * 5. **It stops.** Converged, three rounds without improvement, or four rounds
 *    total - and which of those happened is recorded, because "it stopped
 *    improving" is a real answer and has to be visible.
 */

export type Severity = "wrong" | "approximate" | "cosmetic";

export type Discrepancy = {
  /** A dotted path into the room's spec. */
  path: string;
  severity: Severity;
  /** What the photograph shows. */
  observed: string;
  /** What to put there, as a string to be parsed against the field. */
  proposed: string;
  confidence: "high" | "low";
};

/**
 * The only fields a verify pass may write.
 *
 * Everything on this list is a dimension or a count - something a render and a
 * photograph can be compared on directly, and something whose being wrong is
 * visible as a shape rather than as a shade. Nothing on it is a colour or a
 * material, and that exclusion is the single cheapest protection in the whole
 * design.
 */
export const VERIFIABLE = [
  "ceiling.heightM",
  "ceiling.kind",
  "ceiling.beams.count",
  "ceiling.beams.axis",
  "trim.baseboardM",
  "trim.crown",
] as const;

/** Joinery and openings are addressed per item, so they match by prefix. */
const VERIFIABLE_PREFIXES = ["joinery.", "openings."];

/** Which of a joinery item's fields may move. Never its colour or its style. */
const VERIFIABLE_JOINERY_FIELDS = ["lengthM", "alongM", "depthM", "tier", "wall"];

export function isVerifiable(path: string): boolean {
  if ((VERIFIABLE as readonly string[]).includes(path)) return true;
  if (path.startsWith("openings.") && path.endsWith(".kind")) return true;
  if (path.startsWith("joinery.")) {
    const field = path.split(".").pop() ?? "";
    return VERIFIABLE_JOINERY_FIELDS.includes(field);
  }
  return VERIFIABLE_PREFIXES.some((p) => p.startsWith(path));
}

export type LoopState = {
  /** Values each path has already been given, so a cycle can be spotted. */
  seen: Record<string, string[]>;
  /** Paths that oscillated and are no longer accepted. */
  frozen: string[];
  /** One entry per round: the score it reached and whether it was kept. */
  rounds: Array<{ score: number; kept: boolean }>;
};

export const emptyLoop = (): LoopState => ({ seen: {}, frozen: [], rounds: [] });

/** How much better a round has to be before it counts as better at all. */
export const NOISE_FLOOR = 0.03;

export const MAX_ROUNDS = 4;
export const MAX_BARREN_ROUNDS = 3;
export const CONVERGED = 0.82;

/** At most this many corrections a round, so a fallen score can be attributed. */
export const MAX_PER_ROUND = 2;

/**
 * Fields whose value is a fraction, and the range one has to stay inside.
 *
 * Belt as well as braces. The prompt is told what these mean, and a correction
 * is still written straight into the spec without going back through Zod - so a
 * confident "3.5" for a 3.5-metre run would otherwise be stored, and every
 * consumer downstream would clamp it to the whole wall silently.
 */
export const FRACTIONS = ["lengthM", "alongM"];

/** Whether a proposed value can be stored at this path at all. */
export function inRange(path: string, proposed: string): boolean {
  if (!FRACTIONS.some((f) => path.endsWith(f))) return true;
  const value = Number(proposed);
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export type Filtered = {
  apply: Discrepancy[];
  /** Everything refused, and why, for the editor to show. */
  refused: Array<{ path: string; reason: string }>;
};

/**
 * Which of a round's discrepancies are allowed through.
 *
 * Ordered most severe first and capped, so that when a round is rolled back
 * there are few enough changes to say which one cost it.
 */
export function admissible(
  diffs: Discrepancy[],
  spec: RoomSpec,
  loop: LoopState,
): Filtered {
  const refused: Filtered["refused"] = [];
  const rank: Record<Severity, number> = { wrong: 0, approximate: 1, cosmetic: 2 };

  const passed = diffs.filter((d) => {
    if (d.severity === "cosmetic") {
      refused.push({ path: d.path, reason: "cosmetic" });
      return false;
    }
    if (!isVerifiable(d.path)) {
      refused.push({
        path: d.path,
        reason: "not something a render and a photograph can be compared on",
      });
      return false;
    }
    if (spec.source[d.path] === "human") {
      refused.push({ path: d.path, reason: "you set this by hand" });
      return false;
    }
    if (loop.frozen.includes(d.path)) {
      refused.push({ path: d.path, reason: "this field has already been argued over" });
      return false;
    }
    if ((loop.seen[d.path] ?? []).includes(d.proposed)) {
      refused.push({ path: d.path, reason: "it has proposed this value before" });
      return false;
    }
    if (!inRange(d.path, d.proposed)) {
      refused.push({ path: d.path, reason: "out of range for this field" });
      return false;
    }
    if (d.confidence === "low" && d.severity !== "wrong") {
      refused.push({ path: d.path, reason: "not confident enough to act on" });
      return false;
    }
    return true;
  });

  const sorted = [...passed].sort((a, z) => rank[a.severity] - rank[z.severity]);
  for (const extra of sorted.slice(MAX_PER_ROUND)) {
    refused.push({ path: extra.path, reason: "left for the next round" });
  }

  return { apply: sorted.slice(0, MAX_PER_ROUND), refused };
}

/** Record what a round proposed, freezing anything that has come round again. */
export function remember(loop: LoopState, applied: Discrepancy[]): LoopState {
  const seen = { ...loop.seen };
  const frozen = [...loop.frozen];

  for (const diff of applied) {
    const history = seen[diff.path] ?? [];
    if (history.includes(diff.proposed) && !frozen.includes(diff.path)) {
      frozen.push(diff.path);
    }
    seen[diff.path] = [...history, diff.proposed];
    // Two goes at one field is enough. A third is the loop talking to itself.
    if (seen[diff.path].length >= 2 && !frozen.includes(diff.path)) frozen.push(diff.path);
  }

  return { ...loop, seen, frozen };
}

export type Verdict =
  | { done: false }
  | { done: true; because: "converged" | "no-improvement" | "budget" | "nothing-left" };

/**
 * Whether to go round again.
 *
 * `score` is the latest round's, `best` the best so far. A round that fails to
 * beat the best by more than the noise floor is barren, and three barren rounds
 * means there is nothing more to be had.
 */
export function verdict(loop: LoopState, pending: number): Verdict {
  const rounds = loop.rounds;
  const last = rounds[rounds.length - 1];

  if (last && last.score >= CONVERGED) return { done: true, because: "converged" };
  if (rounds.length >= MAX_ROUNDS) return { done: true, because: "budget" };
  if (pending === 0) return { done: true, because: "nothing-left" };

  const barren = [...rounds].reverse().findIndex((r) => r.kept);
  const runOfBarren = barren === -1 ? rounds.length : barren;
  if (runOfBarren >= MAX_BARREN_ROUNDS) return { done: true, because: "no-improvement" };

  return { done: false };
}

/** Whether a round's score is enough of an improvement to keep it. */
export function keeps(score: number, best: number): boolean {
  return score > best + NOISE_FLOOR;
}
