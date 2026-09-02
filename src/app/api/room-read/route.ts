import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { outputConfig, policyFor } from "@/lib/ai/policy";
import { z } from "zod";

import { SCALE_TOLERANCE, scaleError, snapTo } from "@/lib/spec/standards";
import { quantiseColour } from "@/lib/spec/schema";

/**
 * Read what a room is made of, from its photographs.
 *
 * The condition pass asks how worn a room is. This asks what it *is* - the
 * floor, the walls, the ceiling, the skirting, and whether the wall to the next
 * room has a door in it or is an opening. Between them they are the two halves
 * of "this particular house": one says what to build, the other says what it
 * would cost to put right.
 *
 * The design problem here is measurement. A model looking at a photograph is
 * good at recognising a thing and poor at sizing it, and a wrong dimension is
 * the worst kind of wrong because everything derived from it stays perfectly
 * self-consistent. Three things address that, and they are the substance of
 * this route:
 *
 * **It has to declare its ruler before it measures.** `scaleRef` is the first
 * field in the schema, so it is generated first and every dimension after it is
 * conditioned on it. It is also checkable: when the model says it measured
 * against the doorway, the true width is already known here, and a reading
 * whose implied scale is out by more than 15% has its dimensions dropped rather
 * than believed.
 *
 * **It is told the budget.** Each room arrives with its real dimensions and
 * which of its walls have doorways. Stating out loud that the north wall is
 * 4.3m long is what stops a 5m run of anything being described on it.
 *
 * **Stock sizes are applied by the server, not asked for.** Skirting comes in
 * six heights and ceilings are framed to a standard stud, so a reading of 141mm
 * becomes a 140mm board here. A reading that matches nothing is kept exactly as
 * it came and flagged, because a house genuinely can be odd and rounding that
 * away would delete the only interesting thing about the room.
 */

export const maxDuration = 120;

/**
 * Fewer than the condition pass, and larger.
 *
 * Six small photographs are right for judging wear, which is a question about
 * surfaces. Telling a shaker door from a slab one, or an ogee skirting from a
 * square one, is a question about edges - and edges are the first thing a JPEG
 * throws away. So this trades two photographs for the resolution to see them.
 */
const MAX_PHOTOS = 4;

const FLOOR_MATERIALS = ["wood", "tile", "stone", "carpet", "concrete", "grass"] as const;
const WALL_MATERIALS = [
  "paint",
  "wallpaper",
  "tile",
  "panelling",
  "exposed-brick",
  "timber",
] as const;
const PROFILES = ["square", "ogee", "stepped", "colonial", "chamfer"] as const;
const CEILINGS = ["flat", "tray", "coffered", "beamed", "vaulted", "sloped"] as const;
const DOOR_STYLES = ["shaker", "slab", "raised-panel", "glazed", "beadboard"] as const;
const WORKTOPS = [
  "quartz",
  "granite",
  "laminate",
  "butcher-block",
  "stainless",
  "marble",
] as const;

const ReadSchema = z.object({
  /**
   * First, deliberately. Generated before any dimension, so the dimensions are
   * conditioned on a stated ruler rather than on an unstated feeling.
   */
  scaleRef: z.object({
    object: z
      .string()
      .describe(
        "The thing in shot you are sizing everything else against - an interior door, a light switch, a floor tile, a kitchen base unit",
      ),
    assumedWidthM: z.number().describe("How wide that thing really is, in metres"),
  }),
  fitsGivenDimensions: z
    .boolean()
    .describe("Does the room you can see match the dimensions you were told it has"),

  /**
   * How big the room is, when nobody has already measured it.
   *
   * Asked only where there is no survey to defer to - a single room built from
   * photographs alone has no footprint, no map and no plan, so this is the only
   * thing that knows. Measured against the ruler declared above and checked
   * against it on the way back, exactly as the ceiling height is: a reading
   * taken against an object whose real size the model got wrong is thrown away
   * rather than believed, because a room of confidently the wrong size looks
   * exactly like a room of the right one.
   */
  measuredWidthM: z
    .number()
    .nullable()
    .describe(
      "Only when you were NOT given dimensions: how wide the room is along its longer floor direction, in metres, counted against your scale reference. null if you cannot tell.",
    ),
  measuredDepthM: z
    .number()
    .nullable()
    .describe(
      "Only when you were NOT given dimensions: the other floor direction, in metres. null if you cannot tell.",
    ),

  floorMaterial: z.enum(FLOOR_MATERIALS).nullable().describe("null if the floor is not visible"),
  floorColour: z.string().nullable().describe("#rrggbb of the floor, or null"),

  wallMaterial: z.enum(WALL_MATERIALS).nullable(),
  wallColour: z.string().nullable().describe("#rrggbb of the walls, or null"),

  ceilingHeightM: z
    .number()
    .nullable()
    .describe("Floor to ceiling in metres, or null if you cannot judge it"),
  ceilingKind: z.enum(CEILINGS).nullable(),
  ceilingColour: z.string().nullable(),
  beamCount: z.number().int().nullable().describe("Only for a beamed ceiling, else null"),

  baseboardM: z.number().nullable().describe("Height of the skirting board in metres, or null"),
  baseboardProfile: z.enum(PROFILES).nullable(),
  trimColour: z.string().nullable().describe("#rrggbb of the skirting and casings, or null"),

  openings: z
    .array(
      z.object({
        toRoom: z.string().describe("The neighbouring room's name, exactly as given to you"),
        kind: z
          .enum(["door", "cased", "open", "none"])
          .describe(
            "door: a doorway with a door or a door-sized gap. cased: a wide trimmed opening with wall above it. open: no wall between the rooms at all. none: no way through here.",
          ),
      }),
    )
    .describe("Only for neighbours you can actually see the opening to"),

  /**
   * The fitted joinery, described rather than located.
   *
   * Deliberately no wall, no position and no length. A photograph does not say
   * which way is north, and asking anyway would get a confident answer built on
   * nothing - whereas the plan knows exactly which wall has the clearest run
   * and can place the units there. So the split is the same one the whole route
   * is built on: the model says what a thing looks like, the code says where it
   * goes and how big it is.
   */
  joinery: z
    .object({
      present: z.boolean().describe("Are there fitted units in this room at all"),
      doorStyle: z.enum(DOOR_STYLES).nullable(),
      colour: z.string().nullable().describe("#rrggbb of the cabinet doors"),
      hasWallUnits: z.boolean().describe("Cupboards mounted on the wall above the worktop"),
      hasIsland: z.boolean().describe("A run standing free of the walls"),
      worktopMaterial: z.enum(WORKTOPS).nullable(),
      worktopColour: z.string().nullable(),
      hardware: z.enum(["bar", "knob", "edge", "none"]).nullable(),
    })
    .nullable()
    .describe("null when no fitted units are visible"),

  notes: z.string().describe("Anything worth saying about the room, or empty"),
});

const SYSTEM = `You read what a room is made of, from photographs, so that a 3D replica of it can be built.

You are describing the *building*, not its contents. Ignore furniture, rugs, curtains, art, plants and anything the seller will take with them. A rug is not a floor. Report the floor under it, or null if the rug hides it.

Start with scaleRef. Name one thing in the photograph whose real size you are confident of, and state that size. An interior door leaf is 0.81m wide, a light switch plate 0.086m, a kitchen base unit 0.6m deep and 0.87m to the worktop, a standard floor tile 0.3m or 0.6m. Every dimension you give afterwards should be a multiple of that object, measured against it in the image. Do not estimate dimensions any other way.

Usually you will be told the room's real width and depth. If what you see cannot be that size, set fitsGivenDimensions false and still answer using the dimensions you were given - they come from a survey and you do not. Leave measuredWidthM and measuredDepthM null in that case; you were not asked.

Where you are **not** given dimensions, nothing else has measured this room and you are the only thing that can. Fill in measuredWidthM and measuredDepthM by counting your scale reference across the floor - a 0.81m door leaf laid end to end along the wall, a 0.6m base unit, a 0.3m tile. Say null rather than guess: a room of confidently the wrong size is indistinguishable from a room of the right one, and a refusal costs only a typical room instead of a wrong one.

Rules that matter more than the rest:

- **null is a good answer.** An element no photograph shows well enough is null. A plausible default is worse than an absence, because an absence can be filled in later and a default cannot be told apart from a reading. Do not infer a ceiling height from a room's size, or a skirting profile from its era.
- **Colours are of the thing, not of the light.** Listing photographs are shot with a wide lens and heavy processing, and white walls come out blue in shade and orange under tungsten. Report the colour the surface would be under daylight. If a room is too colour-cast to judge, null.
- **Skirting is measured, not guessed.** If you cannot see a clean run of skirting against something you can size, null. It is a small number and a wrong one propagates to the whole house.
- **A ceiling is flat unless you can see that it is not.** Beams, a tray, coffers and a vault are all obvious when present. Do not report one because a room feels grand.
- **Openings.** A doorway with a door in it, or a door-sized gap with casing, is "door". A wide trimmed opening with wall above it is "cased". Two rooms with no wall between them at all are "open". Only report an opening you can actually see; do not list a neighbour because you were told it is adjacent.
- **Joinery.** Describe the fitted units - what the doors look like, what colour they are, what the worktop is - and nothing about where they are. You cannot tell which wall is which from a photograph and you are not being asked to. A shaker door has a flat centre panel inside a raised frame; a slab door is one flat face with no frame at all; the difference is a line of shadow a few millimetres wide around the edge of each door, and it is the single most telling thing about a kitchen's age.`;

export async function GET() {
  return Response.json({ available: Boolean(process.env.ANTHROPIC_API_KEY) });
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "no-api-key" }, { status: 501 });
  }

  let body: {
    room?: string;
    widthM?: number;
    depthM?: number;
    ceilingM?: number;
    /** Neighbour room names, so an opening can be reported against one. */
    neighbours?: string[];
    /** Which sides face outdoors, which is where the windows are. */
    exteriorWalls?: string[];
    photos?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  const room = String(body.room ?? "").trim();
  const photos = (body.photos ?? []).slice(0, MAX_PHOTOS);
  const neighbours = (body.neighbours ?? []).filter((n) => typeof n === "string");
  const widthM = Number(body.widthM) || 0;
  const depthM = Number(body.depthM) || 0;

  if (!room) return Response.json({ error: "nothing-to-do" }, { status: 400 });

  const M_PER_FT = 0.3048;
  const context =
    `This is the ${room}. ` +
    (widthM && depthM
      ? `It measures ${(widthM / M_PER_FT).toFixed(0)}ft by ${(depthM / M_PER_FT).toFixed(0)}ft ` +
        `(${widthM.toFixed(2)}m by ${depthM.toFixed(2)}m), and its walls are therefore ` +
        `${widthM.toFixed(1)}m and ${depthM.toFixed(1)}m long. `
      : // Said here as well as in the system prompt, because the absence of a
        // sentence is not an instruction. Told only that dimensions were
        // missing, the model returned null for them and, being unsure of the
        // scale, went on to return null for the ceiling height too - so the
        // silence cost both measurements rather than one.
        "**Nobody has measured this room.** There is no survey, no floor plan and no " +
        "map - you are the only thing that can size it. Fill in measuredWidthM and " +
        "measuredDepthM by counting your scale reference across the floor, and set " +
        "fitsGivenDimensions true since there is nothing to disagree with. ") +
    (neighbours.length > 0
      ? `It opens onto: ${neighbours.join(", ")}. Report an opening only for the ones you can see. `
      : "") +
    (body.exteriorWalls?.length ? `Outside walls: ${body.exteriorWalls.join(", ")}. ` : "");

  const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: context }];

  // Addressed by position, never by id. Ids differing by a character produce
  // shuffled but plausible output, which is the reason `/api/classify` gives
  // and it holds just as well here.
  let attached = 0;
  for (const dataUrl of photos) {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
    if (!match) continue;
    attached++;
    content.push({ type: "text", text: `Photo ${attached}:` });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: match[1] as "image/jpeg" | "image/png" | "image/webp",
        data: match[2],
      },
    });
  }

  // Nothing to look at is a real answer and it does not cost a request.
  if (attached === 0) {
    return Response.json({ error: "no-photos" }, { status: 400 });
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: policyFor("room-read").model,
      max_tokens: policyFor("room-read").maxTokens,
      output_config: outputConfig("room-read", zodOutputFormat(ReadSchema)),
      system: [
        {
          type: "text",
          text: SYSTEM,
          // Identical on every call of a build - seven for the photographs,
          // one per room for the interiors - so it is written to the cache
          // once and read back for the rest at a tenth of the price. The
          // prompts here are long, and on a nine-room house this is the
          // largest single saving available without changing an answer.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content }],
    });

    if (response.stop_reason === "refusal") {
      return Response.json({ error: "refused" }, { status: 422 });
    }
    if (!response.parsed_output) {
      return Response.json({ error: "unparsed" }, { status: 502 });
    }

    return Response.json(reconcile(response.parsed_output, { widthM, depthM, neighbours }));
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return Response.json({ error: "bad-key" }, { status: 401 });
    }
    if (error instanceof Anthropic.RateLimitError) {
      return Response.json({ error: "rate-limited" }, { status: 429 });
    }
    if (error instanceof Anthropic.APIError) {
      return Response.json({ error: "api", status: error.status }, { status: 502 });
    }
    return Response.json({ error: "unknown" }, { status: 500 });
  }
}

/**
 * Objects whose real size is known here, for checking a stated ruler against.
 *
 * Each carries every dimension it might reasonably have been measured on,
 * because a base unit is 0.6m deep *and* 0.87m to the worktop and the model is
 * right either way. The first version of this listed one number apiece and
 * promptly rejected a perfectly good kitchen reading for saying 0.87 where the
 * table said 0.6 - a check that fires on correct answers is worse than no check
 * at all, because it throws away the dimensions it was meant to protect.
 *
 * So: unambiguous objects get a single value, ambiguous ones get the set, and
 * anything not listed is not checked. Fewer things checked correctly beats more
 * things checked wrongly.
 */
const KNOWN_SIZES: Array<[RegExp, number[]]> = [
  // A door leaf is only ever measured across.
  [/door/i, [0.686, 0.762, 0.813, 0.914, 2.03]],
  [/switch|socket|outlet/i, [0.086, 0.115]],
  // Depth, height to the worktop, and standard carcass widths.
  [/base ?unit|base ?cabinet|counter|worktop/i, [0.6, 0.87, 0.9, 0.3, 0.45]],
  [/skirt|baseboard/i, [0.076, 0.089, 0.114, 0.14, 0.165, 0.19]],
  [/tile/i, [0.1, 0.15, 0.2, 0.3, 0.45, 0.6]],
];

/**
 * Everything the answer has to survive before it is allowed to be stored.
 *
 * Deliberately here rather than in the prompt. A rule a model is asked to
 * follow is a rule it follows most of the time; a rule applied to its output is
 * one it cannot break. The same split `outlineIsPlausible` already makes for
 * the satellite trace: an objective gate beats a stated confidence.
 */
function reconcile(
  parsed: z.infer<typeof ReadSchema>,
  room: { widthM: number; depthM: number; neighbours: string[] },
) {
  const dropped: string[] = [];

  // Does the stated ruler check out? When the object is one whose real size is
  // known here, the model has handed over enough to mark its own homework.
  const known = KNOWN_SIZES.find(([pattern]) => pattern.test(parsed.scaleRef.object));
  const error = known
    ? Math.min(...known[1].map((size) => scaleError(parsed.scaleRef.assumedWidthM, size)))
    : 0;
  const rulerHolds = error <= SCALE_TOLERANCE;

  /**
   * Two different questions that used to be one.
   *
   * `fitsGivenDimensions` asks whether the room matches a survey, and it is
   * meaningless where there is no survey - a single room built from
   * photographs has no footprint and no plan, so nothing was given to fit. Left
   * folded together, a dimension-less call would answer "no, it does not fit
   * the dimensions I was not given" and silently throw away the ceiling height
   * and the skirting, which for that room are the only two measurements there
   * are.
   *
   * So the ruler is checked on its own, and the survey only where one exists.
   */
  const hadDimensions = room.widthM > 0 && room.depthM > 0;
  const trustDimensions = rulerHolds && (!hadDimensions || parsed.fitsGivenDimensions);
  if (!trustDimensions) {
    dropped.push(
      known && !rulerHolds
        ? `measured against a "${parsed.scaleRef.object}" it called ${parsed.scaleRef.assumedWidthM}m, which is no size one comes in`
        : "the room it described is not the size the survey says it is",
    );
  }

  /**
   * The room's own size, where nothing else knew it.
   *
   * Through the same gate as everything else: a reading taken against an object
   * whose real size the model got wrong is thrown away rather than believed.
   * Then banded, because the failure this is guarding against is not a metre
   * out - it is an order of magnitude, from counting the wrong object - and a
   * two-metre-square living room or a forty-metre bedroom is a scale error that
   * got through rather than a room.
   */
  const measured =
    !hadDimensions && rulerHolds
      ? (() => {
          const w = parsed.measuredWidthM;
          const d = parsed.measuredDepthM;
          if (!w || !d) return null;
          const plausible = (v: number) => v >= 1.2 && v <= 20;
          if (!plausible(w) || !plausible(d)) {
            dropped.push(
              `it measured the room at ${w.toFixed(1)}m by ${d.toFixed(1)}m, which is not a room`,
            );
            return null;
          }
          // Rounded to the nearest six inches, the way every other dimension
          // here is, so a wall reads as deliberate rather than as arithmetic.
          const round = (v: number) => Math.round(v / 0.1524) * 0.1524;
          return { widthM: round(Math.max(w, d)), depthM: round(Math.min(w, d)) };
        })()
      : null;

  const ceiling = trustDimensions ? snapTo(parsed.ceilingHeightM, "ceilingM") : null;
  const baseboard = trustDimensions ? snapTo(parsed.baseboardM, "baseboardM") : null;

  // A skirting taller than a fifth of the wall, or a ceiling that would not fit
  // a person, is not a reading - it is a scale error that got through.
  const plausibleCeiling = ceiling && ceiling.value >= 2.0 && ceiling.value <= 6;
  const plausibleBaseboard = baseboard && baseboard.value >= 0.04 && baseboard.value <= 0.4;

  const wanted = new Set(room.neighbours.map((n) => n.toLowerCase()));
  const openings = parsed.openings.filter((o) => wanted.has(o.toRoom.trim().toLowerCase()));

  return {
    joinery:
      parsed.joinery && parsed.joinery.present
        ? {
            doorStyle: parsed.joinery.doorStyle,
            colour: quantiseColour(parsed.joinery.colour),
            hasWallUnits: parsed.joinery.hasWallUnits,
            hasIsland: parsed.joinery.hasIsland,
            worktopMaterial: parsed.joinery.worktopMaterial,
            worktopColour: quantiseColour(parsed.joinery.worktopColour),
            hardware: parsed.joinery.hardware,
          }
        : null,
    floor: {
      material: parsed.floorMaterial,
      colour: quantiseColour(parsed.floorColour),
    },
    walls: {
      material: parsed.wallMaterial,
      colour: quantiseColour(parsed.wallColour),
    },
    ceiling: {
      heightM: plausibleCeiling ? ceiling.value : null,
      kind: parsed.ceilingKind,
      colour: quantiseColour(parsed.ceilingColour),
      beams:
        parsed.ceilingKind === "beamed" && parsed.beamCount && parsed.beamCount > 0
          ? { count: Math.min(parsed.beamCount, 24), axis: room.widthM >= room.depthM ? "y" : "x" }
          : null,
    },
    trim: {
      baseboardM: plausibleBaseboard ? baseboard.value : null,
      profile: parsed.baseboardProfile,
      colour: quantiseColour(parsed.trimColour),
    },
    openings,
    /** How big the room is, when nothing else had measured it. Null otherwise. */
    measured,
    /** Sizes that matched no stock size. Shown as "unusual, worth checking". */
    offStandard: [
      ceiling && !ceiling.snapped && plausibleCeiling ? "ceiling height" : null,
      baseboard && !baseboard.snapped && plausibleBaseboard ? "skirting height" : null,
    ].filter(Boolean),
    dropped,
    notes: parsed.notes,
  };
}
