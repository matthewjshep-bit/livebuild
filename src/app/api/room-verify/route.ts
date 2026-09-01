import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { outputConfig, policyFor } from "@/lib/ai/policy";
import { z } from "zod";

/**
 * Compare the room that was built against the photograph it was built from.
 *
 * Everything else in the pipeline reads a photograph and produces a house. This
 * closes the loop: render the room from where the lens stood, put the two
 * images side by side, and ask what is different. A difference between them is
 * a difference in the building, because the vantage point is the same by
 * construction.
 *
 * The prompt is doing one job above all others, and it is not finding
 * differences - a model given two images will always find differences. It is
 * establishing which differences *mean* anything. A render is a simplified
 * architectural model, so it differs from a photograph in exposure, in colour
 * temperature, in texture detail, in sharpness and in every stick of furniture,
 * and none of that is the house being wrong. Only where a thing is, how big it
 * is, and whether it is there at all can be read across the gap.
 *
 * The answer is a bounded list of typed differences against a closed list of
 * paths supplied by the caller. Free-form text would be unappliable and an
 * invitation to invent, and a path the room does not have is a correction that
 * cannot land.
 */

export const maxDuration = 120;

const DiffSchema = z.object({
  path: z
    .string()
    .describe("Exactly one of the paths you were given. Never anything else."),
  severity: z
    .enum(["wrong", "approximate", "cosmetic"])
    .describe(
      "wrong: plainly not what the photograph shows. approximate: right in kind, out in degree. cosmetic: too small to matter.",
    ),
  observed: z.string().describe("What the photograph shows, in a few words"),
  rendered: z.string().describe("What the model shows instead"),
  proposed: z.string().describe("The value to put there. A number, or one of the allowed words."),
  confidence: z.enum(["high", "low"]),
});

const VerifySchema = z.object({
  /**
   * Asked first and answered first, because everything after it is worthless
   * if the two images are not of the same view. Two different corners of one
   * room differ in every particular, and a model asked only "what is different"
   * will faithfully list all of it.
   */
  poseFit: z.object({
    sameViewpoint: z.boolean(),
    problem: z
      .enum(["none", "camera-too-far", "camera-too-close", "facing-wrong-wall", "different-room"])
      .describe("none when the two images are of the same view"),
  }),
  /** 0 is unrecognisable, 1 is the same room built correctly. */
  score: z.number().min(0).max(1),
  diffs: z.array(DiffSchema).max(6),
  notes: z.string(),
});

const SYSTEM = `You compare a 3D model of a room against a photograph of the real room, so the model can be corrected.

The first image is the model, rendered from the position the photograph was taken from. The second is the photograph.

**What is not a difference.** The model is a simplified architectural render and will never look like a photograph. Ignore, completely:
- exposure, brightness, contrast, white balance, colour temperature, saturation
- shadows, reflections, glare, the look of the light
- texture detail, grain, sharpness, noise, resolution
- every piece of furniture, every rug, every curtain, every plant, every object on a surface
- people, pets, clutter, staging

None of those tell you anything about whether the house was built correctly, and reporting them wastes the answer.

**What is a difference.** Only what is *built*:
- where a wall is, and whether a room is the shape the photograph shows
- how high the ceiling is, and whether it is flat, beamed, trayed or coffered
- where a run of fitted units is, how long it is, and whether there are wall cupboards over it
- whether an opening is a door or an archway
- how tall the skirting is

**poseFit first.** If the two images are not looking at the same part of the same room, say so and return no differences at all. A model rendered from a slightly wrong position differs from the photograph in everything, and every one of those differences would be wrong to act on.

**Paths.** You will be given the exact list of paths you may propose against. Use one of them or say nothing. Do not invent a path, and do not propose against a path that is not on the list even if you can see something wrong there - it means that field is not one this comparison can settle.

**Be sparing.** A handful of real differences is a useful answer. Six marginal ones is noise, and the loop that consumes this will act on the most severe first - so put your confidence where you have it. If the room looks right, say so with a high score and no differences: that is the outcome everybody wants and it is a real answer.`;

export async function GET() {
  return Response.json({ available: Boolean(process.env.ANTHROPIC_API_KEY) });
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "no-api-key" }, { status: 501 });
  }

  let body: {
    room?: string;
    render?: string;
    photo?: string;
    /** The only paths a correction may name. */
    paths?: string[];
    /** What the model currently believes, so a difference has a baseline. */
    current?: Record<string, string>;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  const room = String(body.room ?? "").trim();
  const paths = (body.paths ?? []).filter((p) => typeof p === "string");
  if (!room || !body.render || !body.photo || paths.length === 0) {
    return Response.json({ error: "nothing-to-do" }, { status: 400 });
  }

  const image = (dataUrl: string): Anthropic.ContentBlockParam | null => {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
    if (!match) return null;
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: match[1] as "image/jpeg" | "image/png" | "image/webp",
        data: match[2],
      },
    };
  };

  const render = image(body.render);
  const photo = image(body.photo);
  if (!render || !photo) return Response.json({ error: "bad-images" }, { status: 400 });

  const current = Object.entries(body.current ?? {})
    .map(([path, value]) => `  ${path} = ${value}`)
    .join("\n");

  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text:
        `This is the ${room}.\n\n` +
        `Paths you may propose against, and nothing else:\n${paths.map((p) => `  ${p}`).join("\n")}\n\n` +
        (current ? `What the model currently has:\n${current}\n\n` : ""),
    },
    { type: "text", text: "Image 1 - the model:" },
    render,
    { type: "text", text: "Image 2 - the photograph:" },
    photo,
  ];

  try {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: policyFor("room-verify").model,
      max_tokens: policyFor("room-verify").maxTokens,
      output_config: outputConfig("room-verify", zodOutputFormat(VerifySchema)),
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });

    if (response.stop_reason === "refusal") {
      return Response.json({ error: "refused" }, { status: 422 });
    }
    if (!response.parsed_output) {
      return Response.json({ error: "unparsed" }, { status: 502 });
    }

    const parsed = response.parsed_output;

    // Two images of different views have nothing comparable in them, whatever
    // the model went on to say about them.
    if (!parsed.poseFit.sameViewpoint) {
      return Response.json({
        poseFit: parsed.poseFit,
        score: parsed.score,
        diffs: [],
        notes: parsed.notes,
      });
    }

    // The closed list, enforced rather than requested.
    const allowed = new Set(paths);
    return Response.json({
      poseFit: parsed.poseFit,
      score: parsed.score,
      diffs: parsed.diffs.filter((d) => allowed.has(d.path)),
      notes: parsed.notes,
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
