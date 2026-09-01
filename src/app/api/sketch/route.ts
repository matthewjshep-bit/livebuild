import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/**
 * Read a hand-drawn floor plan.
 *
 * The model returns rectangles on a grid rather than a room list, because the
 * arrangement is the whole point - a list would throw away the one thing the
 * drawing was for. Coordinates are deliberately left rough: `sketchToPlan`
 * aligns them afterwards, where the tolerance can be reasoned about, rather
 * than asking the model for a precision it cannot have.
 */

const SketchSchema = z.object({
  gridWidth: z.number().describe("Width of the coordinate space you used"),
  gridHeight: z.number().describe("Height of the coordinate space you used"),
  rooms: z.array(
    z.object({
      label: z.string().describe("Room name as written, tidied to title case"),
      x: z.number().describe("Left edge"),
      y: z.number().describe("Top edge"),
      width: z.number(),
      height: z.number(),
      level: z
        .number()
        .int()
        .describe("0 unless the drawing clearly shows separate floors; then 0, 1, -1"),
      writtenFeet: z
        .object({
          width: z.number().nullable(),
          height: z.number().nullable(),
        })
        .nullable()
        .describe("Dimensions written inside the room in feet, e.g. '12 x 14'. Null if none."),
    }),
  ),
  notes: z.array(z.string()).describe("Two to four short phrases on what you read"),
});

/**
 * What changes when the drawing was drawn by a professional.
 *
 * Appended rather than replacing the prompt, because everything it already says
 * about reading a plan into rectangles is still true - a printed plan is a
 * neater version of the same problem. What differs is that it carries real
 * information a sketch does not: dimension strings, a scale bar, walls with
 * thickness, and a great deal of furniture and annotation drawn to a standard
 * that makes it look load-bearing when it is not.
 */
const FLOORPLAN = `

This drawing is a printed or professionally drawn floor plan rather than a hand sketch. Four things follow:

- **Dimensions are written down.** Strings like 12'-6" x 14'-0", 3.6m x 4.2m, or a number under a room name are the room's real size. Put them in writtenFeet - they are far better than anything measured off the image, and they are the difference between a plan that is the right shape and one that is the right size.
- **Walls have thickness.** A printed plan draws walls as two lines or as a filled band. A room's rectangle is the *inside* of those walls, not the middle and not the outside.
- **There is a lot that is not the building.** Furniture, appliances, fixtures, dimension lines, leader lines, hatching, north arrows, scale bars, title blocks, logos and page furniture. None of it is a room. A bath drawn in a bathroom is not a room; the bathroom is.
- **Rooms are named, and the names are reliable.** Prefer the plan's own label over anything inferred from what is drawn inside it.

Read only the plan itself. If the page shows two floors side by side, use level 0 and 1; if it shows the same floor twice - a furnished and an unfurnished version, or a dimensioned one - read it once.`

const SYSTEM = `You read hand-drawn floor plans and return them as rectangles.

The drawing is usually a phone photo of paper: wobbly lines, uneven lighting, maybe at a slight angle. Read it as if it were straight on and neatly drawn.

Output rules:
- Use a coordinate space of your choosing — state it as gridWidth and gridHeight — with x to the right and y downward, origin at the drawing's top-left.
- One rectangle per room, covering the space that room occupies in the drawing. Rooms that share a wall should share an edge coordinate; do not leave gaps between them.
- Ignore furniture, arrows, hatching and dimension lines. Rooms only.
- Doorways: do NOT return them. Rooms that touch are treated as connected automatically. Just make sure touching rooms actually share an edge.
- label: use what is written. Expand obvious shorthand — "BR"/"BD" is Bedroom, "BA"/"BTH" is Bathroom, "MBR" or "M.BED" is Primary Bedroom, "LR" Living Room, "DR" Dining Room, "KIT"/"K" Kitchen, "GAR" Garage, "HALL" Hallway, "WIC" Closet. If a room is unlabelled, infer from size and position and say so in notes.
- writtenFeet: only when a dimension is actually written inside that room, e.g. "12x14" means width 12 and height 14 in feet. Otherwise null. Do not estimate.
- level: 0 unless the page clearly shows two floors — a second outline labelled "upstairs", "second floor", or similar. Then the ground floor is 0 and the upper is 1, a basement -1.
- notes: what you read and anything you were unsure of. If you inferred an unlabelled room, say which.

Do not invent rooms that are not drawn. A drawing with four boxes has four rooms.`;

export async function GET() {
  return Response.json({ available: Boolean(process.env.ANTHROPIC_API_KEY) });
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "no-api-key" }, { status: 501 });
  }

  let dataUrl: string;
  let kind: "sketch" | "floorplan" = "sketch";
  try {
    const body = await request.json();
    dataUrl = typeof body?.image === "string" ? body.image : "";
    if (body?.kind === "floorplan") kind = "floorplan";
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return Response.json({ error: "bad-image" }, { status: 400 });
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 16000,
      // Reading a wobbly sketch into consistent coordinates is genuinely harder
      // than naming a room, and a misread here costs the user the whole layout.
      output_config: { effort: "high", format: zodOutputFormat(SketchSchema) },
      system: kind === "floorplan" ? SYSTEM + FLOORPLAN : SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: match[1] as "image/jpeg" | "image/png" | "image/webp",
                data: match[2],
              },
            },
            { type: "text", text: "Read this floor plan." },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return Response.json({ error: "refused" }, { status: 422 });
    }
    if (!response.parsed_output || response.parsed_output.rooms.length === 0) {
      return Response.json({ error: "no-rooms" }, { status: 422 });
    }

    return Response.json(response.parsed_output);
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
