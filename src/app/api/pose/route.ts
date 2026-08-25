import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/**
 * Work out where in a room each photo was taken from.
 *
 * Until now every photo was dropped in a corner facing the middle. That is a
 * decent guess about how listing photos are shot, and it is wrong often enough
 * to matter: a kitchen shot down the counter run, a bathroom taken from the
 * doorway, a bedroom framed from the foot of the bed all end up facing the
 * wrong way, and the tour turns to face a wall.
 *
 * The photo alone cannot say where north is. What anchors it is everything else
 * already known about the room: its dimensions, and - critically - where its
 * doorways are. A doorway visible in shot fixes the orientation completely.
 */

const PoseSchema = z.object({
  poses: z.array(
    z.object({
      index: z.number().int().describe("1-based position of the photo, as labelled"),
      u: z.number().describe("Across the room's width, 0 at the west wall, 1 at the east"),
      v: z.number().describe("Along the room's depth, 0 at the north wall, 1 at the south"),
      headingDeg: z
        .number()
        .describe("Direction faced: 0 = toward the north wall, 90 = east, 180 = south, 270 = west"),
      fovDeg: z.number().describe("Estimated horizontal field of view, 60-100 for listing photos"),
      doorwayVisible: z.boolean().describe("Whether a doorway is in shot"),
      confidence: z
        .enum(["high", "low"])
        .describe("low when the orientation is genuinely ambiguous"),
    }),
  ),
});

const SYSTEM = `You estimate where a photograph of a room was taken from.

For each photo you are told the room's size and where its doorways are. Give the camera position and the direction it faces, in the room's own coordinates:

- The room is a rectangle. u runs 0 to 1 across its width (0 = west wall, 1 = east wall). v runs 0 to 1 along its depth (0 = north wall, 1 = south wall).
- headingDeg is the compass direction the camera faces within that frame: 0 faces the north wall, 90 the east, 180 the south, 270 the west.

How to work it out:
- A doorway in shot is the strongest clue there is — you are told which wall each doorway is on, so a visible doorway fixes the orientation. Say so with doorwayVisible.
- Otherwise use the geometry of the walls. Listing photos are usually taken from a corner shooting across the long diagonal, so two walls converge toward a corner near the middle of the frame. Which corner is furthest from the camera tells you which way it faces.
- A room shot along its length (a galley kitchen, a corridor) has walls running away in parallel rather than converging to a near corner.
- Estimate u and v as where the photographer stood, usually within a foot or two of a wall or corner. Do not place the camera in the middle of a room unless the photo genuinely looks that way.
- fovDeg: real estate photos are wide, typically 75-90. A tight shot of a fixture may be 50-65.

Set confidence to "low" whenever the room is symmetrical, featureless, or no doorway is visible and the walls do not clearly converge — a plain bedroom corner is often genuinely ambiguous. A wrong pose that claims high confidence will not be checked.`;

const MAX_PHOTOS = 6;

export async function GET() {
  return Response.json({ available: Boolean(process.env.ANTHROPIC_API_KEY) });
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "no-api-key" }, { status: 501 });
  }

  let body: {
    photos?: Array<{
      id: string;
      dataUrl: string;
      room: string;
      widthFt: number;
      depthFt: number;
      doorways?: string[];
    }>;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  const photos = (body.photos ?? []).slice(0, MAX_PHOTOS);
  if (photos.length === 0) {
    return Response.json({ error: "nothing-to-do" }, { status: 400 });
  }

  const content: Anthropic.ContentBlockParam[] = [];
  const order: string[] = [];

  for (const photo of photos) {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(photo.dataUrl ?? "");
    if (!match) continue;
    order.push(photo.id);

    const doorways = photo.doorways?.length
      ? `Doorways on the ${photo.doorways.join(" wall, the ")} wall.`
      : "No doorways recorded for this room.";

    content.push({
      type: "text",
      text:
        `Photo ${order.length}: the ${photo.room}, ` +
        `${photo.widthFt.toFixed(0)} ft wide (west to east) by ` +
        `${photo.depthFt.toFixed(0)} ft deep (north to south). ${doorways}`,
    });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: match[1] as "image/jpeg" | "image/png" | "image/webp",
        data: match[2],
      },
    });
  }

  if (order.length === 0) {
    return Response.json({ error: "no-valid-images" }, { status: 400 });
  }

  content.push({
    type: "text",
    text: `Give one pose per photo, using its number.`,
  });

  try {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 16000,
      // Reasoning about which wall is which from converging perspective lines
      // is the hardest visual judgement in this app, and a wrong answer points
      // the tour at a wall.
      output_config: { effort: "high", format: zodOutputFormat(PoseSchema) },
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });

    if (response.stop_reason === "refusal") {
      return Response.json({ error: "refused" }, { status: 422 });
    }
    if (!response.parsed_output) {
      return Response.json({ error: "unparsed" }, { status: 502 });
    }

    const poses = response.parsed_output.poses
      .filter((p) => p.index >= 1 && p.index <= order.length)
      .map((p) => ({
        id: order[p.index - 1],
        // Clamped rather than trusted: a pose outside the room would put the
        // camera through a wall, and the shell with it.
        u: Math.min(0.94, Math.max(0.06, p.u)),
        v: Math.min(0.94, Math.max(0.06, p.v)),
        headingDeg: ((p.headingDeg % 360) + 360) % 360,
        fovDeg: Math.min(110, Math.max(45, p.fovDeg)),
        doorwayVisible: p.doorwayVisible,
        confidence: p.confidence,
      }));

    return Response.json({ poses });
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
