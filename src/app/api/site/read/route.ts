import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/**
 * A vision call over four images at high effort is not a fast request, and this
 * one now reads appearance and condition together. `/api/listing` is the only
 * other route that sets this, for the same reason: the platform default is
 * short enough to cut it off, and it would only ever be discovered on a
 * deployment.
 */
export const maxDuration = 120;

import { TRACE_FRAME_PX, outlineIsPlausible, pixelsToRing } from "@/lib/site/trace";
import {
  GOOGLE_ATTRIBUTION,
  fetchFacades,
  fetchOverhead,
  findPanorama,
  isImageryConfigured,
} from "@/lib/site/imagery";

/**
 * Look at the house from the road and from above, and say what it is made of.
 *
 * The building's *outline* is not asked for and never will be - that comes from
 * OpenStreetMap, as vectors somebody surveyed, and tracing one out of a
 * photograph would be both worse and the thing Google's terms are about. What
 * is asked for is everything the outline cannot say: how many storeys, what the
 * roof does, what the walls are, which side you knock on.
 *
 * The outline is given to the model rather than withheld, because a reading is
 * far more reliable when it can say "the ridge runs along the long axis of the
 * shape you gave me" than when it has to establish the shape first.
 *
 * The prompt discipline is the one `/api/classify` already uses and for the
 * same reason: a hard rule against inventing what is not visible, and an
 * explicit instruction for the ambiguous case. A confident wrong answer here
 * paints the whole house the wrong colour and puts the front door on the wrong
 * side, and nobody checks a thing that looks decided.
 */

/**
 * Grades for the parts of a house you can see from outside it.
 *
 * Read from the same pictures, in the same call. The imagery is already
 * downloaded here - a satellite frame and up to three shots aimed at the
 * building - and until now only its colours were kept and the pixels dropped.
 * Meanwhile the exterior was being graded from listing photographs that an
 * off-market property does not have, which is most of them. The roof is usually
 * the largest single number in a rehab; guessing it from an absent photograph
 * was the weakest link in the whole estimate.
 *
 * Systems - furnace, wiring, plumbing, water heater - are deliberately absent.
 * A furnace does not appear in a photograph of a house.
 */
const Grade = z.enum(["good", "fair", "dated", "poor", "not_visible"]);

const ConditionSchema = z.object({
  roof: Grade,
  exterior: Grade.describe("siding and paint"),
  windows: Grade.describe("the window units themselves"),
  landscaping: Grade,
  foundation: Grade.describe("only what is visible: stem wall, cracking, settlement"),
  conditionNotes: z.string().describe("A few words on what was actually seen. Empty if nothing."),
});

const ReadSchema = z.object({
  storeys: z
    .number()
    .int()
    .nullable()
    .describe("Habitable floors above ground, counted from window rows on the facade. Null if the facade is not visible."),
  roofShape: z
    .enum(["gable", "hip", "flat", "shed", "gambrel", "mansard", "pyramidal", "round", "complex"])
    .nullable(),
  roofRidgeBearing: z
    .number()
    .nullable()
    .describe("Compass bearing of the ridge line in degrees, 0 = north. Null for a roof with no ridge, such as a flat or pyramidal one."),
  roofPitchDeg: z.number().nullable().describe("Roof pitch in degrees from horizontal, if judgeable from the gable end."),
  roofMaterial: z.string().nullable().describe("e.g. asphalt shingle, tile, metal, slate"),
  roofColour: z.string().nullable().describe("A CSS colour name or #rrggbb hex."),
  wallMaterial: z
    .string()
    .nullable()
    .describe("The dominant cladding: e.g. wood siding, brick, stucco, board and batten, stone, vinyl siding"),
  wallColour: z.string().nullable().describe("A CSS colour name or #rrggbb hex for the main wall colour."),
  frontDoorBearing: z
    .number()
    .nullable()
    .describe("Compass bearing FROM the middle of the building TO its front door, in degrees. Null if no entrance is visible."),
  garageBearing: z
    .number()
    .nullable()
    .describe("Compass bearing from the middle of the building to an attached garage or its doors. Null if there is none."),
  garageBays: z.number().int().nullable(),
  confidence: z.enum(["high", "low"]).describe("low when the imagery is obstructed, dated, or shows the wrong building"),
  notes: z.string().describe("Anything the caller should know, in one sentence. Empty string if nothing."),
  condition: ConditionSchema,
  /**
   * The building's outline, only when the map had none and we asked for it.
   *
   * Absolute pixels in the satellite image as sent - models are markedly worse
   * at normalised or 0-1000 coordinate systems than at the frame's own.
   */
  outlinePixels: z
    .array(z.tuple([z.number(), z.number()]))
    .describe(
      "The main dwelling's outline as [x, y] pixel pairs in the satellite image, going around the building once. Empty array unless you were asked to trace it.",
    ),
  outlineConfidence: z
    .enum(["high", "low"])
    .describe("How sure you are that this outline is the dwelling and not a garage, a shadow or the parcel."),
});

/**
 * Which building we are talking about, and whether its shape is known.
 *
 * These used to be one prompt with the outline substituted in, and with no
 * outline it substituted the literal string "not available" - leaving three
 * rules that referred to a shape which had never been supplied, including "the
 * one matching the outline above". Nothing had noticed because nothing
 * downstream used the answer.
 *
 * They are two prompts now because they are two jobs. Annotating a surveyed
 * outline is a different task from recovering one, and the rule that matters
 * most in each contradicts the other outright.
 */
function knownShape(outline: string, frame: number): string {
  return `You are given the building's true outline, surveyed from a map, in metres:
${outline}

Note it has been rotated to square it up and its origin moved to a corner, so it will not sit over the image; use it to know the building's size and shape, not its position. The building is the one near the middle of the ${frame}px frame.

- Do NOT describe the building's outline, footprint or plan. That is already known and is not what you are being asked for. Never trace or estimate the shape.
- Leave outlinePixels empty and outlineConfidence "low".`;
}

function unknownShape(frame: number): string {
  return `**No map has this building, so you are also being asked to trace it.**

Return its outline in outlinePixels as [x, y] pairs in the satellite image's own pixels - absolute, not normalised - going around the building once. The image is exactly ${frame} by ${frame} pixels, x to the right, y downward, origin top left.

- **The building you want is the one at the centre of the frame.** The image is centred on this property's own address point, so the subject is the dwelling that point falls on - or, when it does not fall on a building at all, the nearest one to the centre. That qualification matters: an address geocodes to the parcel, the kerb or the middle of a driveway at least as often as to the roof, so the centre pixel is frequently on tarmac or grass with houses on either side. Pick the building whose plot the centre belongs to and ignore every other roof in the picture, however much larger or grander. A neighbour's house traced instead of this one is not a near miss - it is a different building, and every room of this house will be built inside its shape.
- Trace the **main dwelling** and only that. A detached garage, a shed, a pool, a patio, a carport and a neighbour's roof are not it, and a driveway is certainly not. If the garage is attached and under the same roofline, include it.
- **Stop at the roof.** A patio, a deck, a pool surround, a pergola and a paved terrace often read as one continuous surface with the house in an overhead view, and including them makes the building far larger than it is - which is worse than a rough trace, because every room is then sized from it and a bedroom comes out the size of a house. The roof has a different texture and casts a shadow; the paving does not.
- Follow the roof's outer edge, which is what you can actually see. Six to twelve corners is normal for a house; do not trace every jog of a bay window or an eave.
- Do not close the ring by repeating the first point.
- **outlineConfidence is about the satellite view alone.** You are tracing a roof from above; whether the facade is screened from the street has nothing to do with it, and a house completely hidden behind trees at ground level is often perfectly plain from the air. Judge only whether you can see this building's roof clearly enough to follow its edge.
- Set outlineConfidence to "low" when the roof itself is obscured by tree canopy or deep shadow, when the building runs past the edge of the frame, when you genuinely cannot tell the dwelling from an outbuilding, or when you cannot tell which of two roofs the centre of the frame belongs to. A wrong outline puts every room of the house into the wrong shape, and it will not look wrong enough for anybody to check it. Refusing costs nothing: a plain rectangle is used instead.`;
}

function systemPrompt(
  shape: string,
  storeysHint: number | null,
): string {
  return `You are describing the outside of one specific house, from a satellite photograph and one or more street-level photographs of it.

${shape}

The satellite image is north-up. The street-level images are labelled with the compass bearing the camera was pointing along.
${storeysHint ? `\nA map source says this building has ${storeysHint} storeys. Treat that as more reliable than your own count unless the photograph plainly contradicts it.\n` : ""}
Rules:
- Report only what is visible in the images. If a facade is hidden by a tree, a fence or a parked van, say so through a low confidence rather than filling it in.
- Bearings are true compass degrees, 0 = north, 90 = east. For the front door, give the direction FROM the centre of the house TO the door - so a door on the south side is 180.
- Colours must be a CSS colour name or a #rrggbb hex, chosen to match what you can see. Do not name a colour you cannot see because of shadow; return null.
- Storeys means habitable floors above ground. Count rows of windows. A finished attic with dormers is not a storey; a raised basement with full windows is.
- Set confidence to "low" whenever the imagery is obstructed, obviously old, or you are not certain it shows the building you were asked about. A wrong answer here repaints the whole house and puts its front door on the wrong side, and nobody will check it.

You are also grading the condition of what you can see, for a renovation scope of work. Use exactly these grades:
- good — recently done or as-new. No work needed.
- fair — serviceable and unremarkable. No work needed.
- dated — sound and functional, but the style or finish is old. Needs refreshing, not replacing.
- poor — damaged, failing, missing, or worn out. Needs replacing.
- not_visible — the imagery does not show this well enough to judge.

What each element means:
- roof — covering condition. Curling, cupped or missing shingles, patching, moss, sagging ridge lines. The satellite view is often the best evidence you have for this; use it.
- exterior — siding and paint. Peeling, chalking, rot, damaged boards, mismatched repairs.
- windows — the units themselves. Single-glazed aluminium or rotten timber frames are poor; sound but old timber is dated; recent double glazing is good.
- landscaping — the yard as it presents. Overgrowth, dead lawn, weeds through hardstanding, failing fences and retaining walls.
- foundation — only what is visible: the exposed stem wall, obvious cracking, settlement, a sagging porch.

Grading rules, which matter more than the appearance ones because this becomes a price:
- not_visible is a good answer and is frequently the right one. A street-level shot of the front tells you nothing about the back of the roof, and a satellite frame tells you nothing about a stem wall.
- Street View imagery can be years old. You are told its date. Judge what is visible, and do not read a sunny well-kept photograph as proof of present condition.
- Do not infer from the building's style or age. Do not guess a roof's remaining life from the shape you identified above.
- Do not be generous and do not be harsh. This drives a real cost estimate in both directions.`;
}

export async function GET() {
  return Response.json({
    available: Boolean(process.env.ANTHROPIC_API_KEY) && isImageryConfigured(),
    imagery: isImageryConfigured(),
    model: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "no-api-key", message: "Set ANTHROPIC_API_KEY in .env.local to enable this." },
      { status: 501 },
    );
  }
  if (!isImageryConfigured()) {
    return Response.json(
      { error: "no-imagery-key", message: "Set GOOGLE_MAPS_API_KEY in .env.local to enable this." },
      { status: 501 },
    );
  }

  let body: {
    lat?: number;
    lon?: number;
    /** The outline in local metres, x east and y south, from the plan frame. */
    outline?: Array<[number, number]>;
    storeys?: number | null;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  const { lat, lon } = body;
  if (typeof lat !== "number" || typeof lon !== "number") {
    return Response.json({ error: "no-location" }, { status: 400 });
  }

  const outline = Array.isArray(body.outline) ? body.outline : [];
  const extentM = outline.length
    ? Math.max(
        Math.max(...outline.map((p) => p[0])) - Math.min(...outline.map((p) => p[0])),
        Math.max(...outline.map((p) => p[1])) - Math.min(...outline.map((p) => p[1])),
      )
    // Nothing is known about the building's size, so the frame has to be
    // generous rather than typical. Guessing 18m framed a real ranch so tightly
    // that it ran off two edges and the trace was refused for it - and the tile
    // is centred on the parcel point, not the house, so a building set back
    // behind trees is off-centre as well as large. Thirty metres roughly
    // doubles the ground covered and still resolves at about 6cm a pixel.
    : 30;

  // The free metadata probe first, so a property with no coverage costs nothing
  // beyond one unbilled request.
  const pano = await findPanorama(lat, lon);
  const [overhead, facades] = await Promise.all([
    fetchOverhead(lat, lon, extentM),
    pano.status === "ok"
      ? fetchFacades(pano, { lat, lon }, extentM)
      : Promise.resolve([]),
  ]);

  if (!overhead && facades.length === 0) {
    // Not an error. A house down a private track has no street view and may
    // have no usable satellite frame either, and the build carries on without.
    return Response.json({ exterior: null, reason: pano.status === "none" ? "no-coverage" : "no-imagery" });
  }

  const content: Anthropic.ContentBlockParam[] = [];
  if (overhead) {
    content.push({
      type: "text",
      text: `Satellite view, north-up, ${overhead.metresPerPixel.toFixed(3)} metres per pixel:`,
    });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: overhead.base64 },
    });
  }
  for (const facade of facades) {
    content.push({
      type: "text",
      text: `Street-level view, camera pointing at compass bearing ${Math.round(facade.heading)} degrees:`,
    });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: facade.base64 },
    });
  }
  content.push({
    type: "text",
    text: outline.length
      ? "Describe this building's exterior. Do not describe its footprint."
      : "Describe this building's exterior, and trace the outline of the main dwelling in the satellite image.",
  });

  const outlineText = outline.length
    ? outline.map(([x, y]) => `(${x.toFixed(1)}, ${y.toFixed(1)})`).join(" ") +
      "  [x east, y south, metres]"
    : "not available";

  try {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 16000,
      // Reading a roof off an oblique photograph is a judgement, not a
      // recognition - the same kind of task as reading a hand-drawn plan, which
      // also runs high.
      output_config: { effort: "high", format: zodOutputFormat(ReadSchema) },
      system: systemPrompt(
        outline.length
          ? knownShape(outlineText, overhead?.size ?? TRACE_FRAME_PX)
          : unknownShape(overhead?.size ?? TRACE_FRAME_PX),
        body.storeys ?? null,
      ),
      messages: [{ role: "user", content }],
    });

    if (response.stop_reason === "refusal") {
      return Response.json({ error: "refused" }, { status: 422 });
    }
    if (!response.parsed_output) {
      return Response.json({ error: "unparsed" }, { status: 502 });
    }

    const read = response.parsed_output;

    let traced: Array<[number, number]> | null = null;
    // Why a trace was not used, said out loud.
    //
    // A refusal and a building nobody tried to trace look identical from
    // outside, and both end with the same rectangle - so without this the only
    // way to tell "the model would not commit" from "the polygon was a shed"
    // is to instrument the route and run it again.
    let traceRefused: string | null = null;

    if (!outline.length && overhead) {
      if (read.outlinePixels.length < 4) {
        traceRefused = "no outline was returned";
      } else {
        const ring = pixelsToRing(
          read.outlinePixels as Array<[number, number]>,
          { lat, lon },
          overhead.metresPerPixel,
          overhead.size,
        );
        // Judged on the shape, not on how sure the model said it was.
        //
        // Requiring "high" as well threw away perfectly good outlines: a real
        // ranch came back the right size and the right proportions, and was
        // refused only because tree canopy covered one wing. The shape gate is
        // objective and already turns away sheds, whole parcels and driveways;
        // stated confidence was a second, softer opinion about the same thing,
        // and the alternative it fell back to is a rectangle invented from a
        // table of typical room sizes. A partly-obscured trace of the actual
        // building beats that, and the confidence is passed on so the build can
        // say how sure it was rather than implying certainty.
        const verdict = outlineIsPlausible(ring);
        if (verdict.ok) {
          traced = ring;
        } else {
          traceRefused = verdict.why;
        }
      }
    }

    const bearing = (value: number | null) =>
      typeof value === "number" && Number.isFinite(value) ? ((value % 360) + 360) % 360 : null;

    return Response.json({
      exterior: {
        storeys: read.storeys && read.storeys > 0 ? read.storeys : null,
        roof:
          read.roofShape || read.roofMaterial || read.roofColour
            ? {
                shape: read.roofShape,
                ridgeBearing: bearing(read.roofRidgeBearing),
                pitchDeg: read.roofPitchDeg,
                material: read.roofMaterial,
                colour: read.roofColour,
              }
            : null,
        walls:
          read.wallMaterial || read.wallColour
            ? { material: read.wallMaterial, colour: read.wallColour }
            : null,
        frontDoorBearing: bearing(read.frontDoorBearing),
        garage:
          read.garageBearing !== null
            ? { bearing: bearing(read.garageBearing)!, bays: read.garageBays }
            : null,
        source: "imagery",
        imageryDate: pano.status === "ok" ? pano.date : null,
        confidence: read.confidence,
        attribution: [GOOGLE_ATTRIBUTION],
      },
      // Only the grades that mean something. `not_visible` is dropped rather
      // than stored, because the bill of materials already treats an absent
      // grade that way and an explicit one would claim somebody looked.
      condition: Object.fromEntries(
        (
          [
            ["roof", read.condition.roof],
            ["exterior", read.condition.exterior],
            ["windows", read.condition.windows],
            ["landscaping", read.condition.landscaping],
            ["foundation", read.condition.foundation],
          ] as const
        ).filter(([, grade]) => grade !== "not_visible"),
      ),
      conditionNotes: read.condition.conditionNotes,
      // The traced outline, already converted out of pixels.
      //
      // Done here rather than by the caller because only here are the tile's
      // centre, zoom and ground resolution all in hand - and the conversion
      // silently produces a plausible-but-wrong building if any of them is
      // guessed. A ring that fails the plausibility gate is dropped rather than
      // returned, so a caller cannot accidentally build on a garden shed.
      tracedRing: traced,
      tracedConfidence: traced ? read.outlineConfidence : null,
      traceRefused,
      notes: read.notes,
      saw: { overhead: Boolean(overhead), facades: facades.length },
    });
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
