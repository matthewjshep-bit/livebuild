/**
 * Which model does which job, and how hard it thinks about it.
 *
 * Every route used to name `claude-opus-5` and `effort: "high"` for itself,
 * which meant the pass that works out *which wall a photograph faces* cost the
 * same as the pass that decides what the house is made of. A build of a
 * nine-room house with thirty-eight photographs makes about thirty calls and
 * sends ninety-odd images, and most of that was the expensive model doing
 * recognition - naming a room, aiming a photograph, parsing a sentence - which
 * is the one thing the cheap model is reliably good at.
 *
 * So the choice is made here, once, per job. Two things follow from that which
 * do not follow from scattering it across nine files: the whole app can be
 * turned down for a test build with one variable, and when a model gains or
 * loses a capability there is exactly one place to change.
 *
 * **Haiku does not accept `effort` at all** - the API refuses the request
 * outright rather than ignoring the parameter - so `effort` is omitted rather
 * than set low wherever the model cannot take it. That is not a detail: sending
 * it anyway turns every photograph classification into a 400 and the build
 * fails with no rooms.
 */

/** Every distinct thing the app asks a model to do. */
export type Job =
  | "classify"
  | "describe"
  | "pose"
  | "layout"
  | "sketch"
  | "condition"
  | "room-read"
  | "room-verify"
  | "site-read";

export type Effort = "low" | "medium" | "high";

export type Policy = {
  model: string;
  /** Absent when the model does not support it. Never send it anyway. */
  effort?: Effort;
  maxTokens: number;
  /** The longest edge a photograph is sent at, for whoever prepares it. */
  imageEdge: number;
  /** JPEG quality for the same. */
  imageQuality: number;
};

const OPUS = "claude-opus-5";
const SONNET = "claude-sonnet-5";
const HAIKU = "claude-haiku-4-5-20251001";

/**
 * Models that will not accept an effort parameter.
 *
 * A list rather than a check on the name, because being wrong here is a hard
 * failure on every call rather than a slightly worse answer.
 */
const NO_EFFORT = new Set([HAIKU]);

/**
 * What each job is worth spending on.
 *
 * The split is between **recognising** and **deciding**. Naming the room in a
 * photograph, working out which wall it faces, and reading a typed sentence are
 * recognition: the answer is either there in front of the model or it is not,
 * and a larger model does not find it harder to see. Reading what a room is
 * built from, tracing a building off a satellite image, arranging rooms inside
 * an outline and comparing a render against a photograph are judgements, and
 * they are the passes whose being wrong shows up in the house.
 *
 * Sketch reading stays expensive despite looking like recognition, because a
 * misread floor plan does not degrade the answer - it replaces the entire
 * layout with a different house's.
 */
const JOBS: Record<Job, { model: string; effort: Effort; imageEdge: number; imageQuality: number }> = {
  // --- recognition ---
  //
  // Classification stays on the expensive model, and that is a measurement
  // rather than caution. Naming the room in a photograph looks like pure
  // recognition, so it was the obvious thing to move - but a build's
  // photographs are all of *one house*, and the real question is "how many
  // distinct rooms are these thirty-eight pictures of". Cheaper models answer
  // that by calling most of them the same room. Counted on the same fixture,
  // photographs landed across five rooms on Opus, three on Sonnet and two on
  // Haiku - three runs each. A tour whose pictures all pile into the living
  // room is not cheaper, it is broken, so the saving is not available here.
  //
  // Worth keeping as a warning: a small model recognises a thing perfectly well
  // and is much worse at telling two similar things apart, and almost every
  // pass in this pipeline is really the second job wearing the first one's
  // clothes.
  classify: { model: OPUS, effort: "low", imageEdge: 768, imageQuality: 0.82 },
  // Parsing an English sentence into a room list, with a deterministic parser
  // behind it if this fails. Nothing about it needs a large model.
  describe: { model: HAIKU, effort: "low", imageEdge: 1024, imageQuality: 0.85 },
  // Which wall a photograph faces. Ten calls a build, and it fails soft: a
  // refusal leaves the corner heuristic every node already has.
  pose: { model: SONNET, effort: "low", imageEdge: 1024, imageQuality: 0.85 },

  // --- judgement ---
  layout: { model: OPUS, effort: "medium", imageEdge: 1024, imageQuality: 0.85 },
  condition: { model: OPUS, effort: "medium", imageEdge: 900, imageQuality: 0.85 },
  sketch: { model: OPUS, effort: "high", imageEdge: 1024, imageQuality: 0.9 },
  "room-read": { model: OPUS, effort: "high", imageEdge: 1024, imageQuality: 0.88 },
  "room-verify": { model: OPUS, effort: "high", imageEdge: 1024, imageQuality: 0.85 },
  "site-read": { model: OPUS, effort: "high", imageEdge: 1024, imageQuality: 0.88 },
};

/**
 * Whether this deployment is building throwaway houses.
 *
 * `NEXT_PUBLIC_` so the browser can see it too: half the cost of a build is
 * images, and they are downscaled on the client long before any route is
 * reached. A flag only the server could read would leave the expensive half of
 * a draft build at full price.
 */
export function isDraft(): boolean {
  const flag = process.env.NEXT_PUBLIC_AI_DRAFT;
  return flag === "1" || flag === "true";
}

export function policyFor(job: Job): Policy {
  const base = JOBS[job];
  // A draft build is for seeing whether the pipeline runs, not whether the
  // house is right, so everything goes to the cheap model at the small size.
  const model = isDraft() ? HAIKU : base.model;
  const effort = NO_EFFORT.has(model) ? undefined : isDraft() ? "low" : base.effort;

  return {
    model,
    effort,
    maxTokens: 16000,
    imageEdge: isDraft() ? Math.min(base.imageEdge, 640) : base.imageEdge,
    imageQuality: isDraft() ? 0.75 : base.imageQuality,
  };
}

/**
 * The `output_config` for a job, with `effort` present only where it is legal.
 *
 * Generic over the format so the schema's type reaches `messages.parse`, which
 * infers `parsed_output` from it. Widening this to `unknown` compiles and then
 * types every route's answer as `never`, which is a long way from where the
 * mistake was made.
 */
export function outputConfig<F>(job: Job, format: F): { effort?: Effort; format: F } {
  const { effort } = policyFor(job);
  return effort ? { effort, format } : { format };
}
