import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/**
 * Where the rooms go inside the building's outline.
 *
 * The packer's own answer is shelf packing by typical room size. It fills the
 * shape exactly and arranges it like a spreadsheet - four bedrooms in a row
 * across the front, because that is the order they arrived in. Nothing in it
 * knows that bedrooms cluster, that a bathroom belongs beside them, that a
 * kitchen opens onto a living room, or that the front door is on a side.
 *
 * So this chooses the arrangement and **only** the arrangement. It returns rows
 * of room indices; `packIntoFootprint` still computes every polygon, so
 * `distribute`, `MIN_ROOM_DIM` and the exact fill of the outline are not things
 * a model answer can violate. A malformed reply is refused by
 * `validatePackPlan` and the packer's own derivation runs instead - which is
 * the behaviour this is trying to beat, so failing costs nothing.
 */

export const maxDuration = 120;

const PlanSchema = z.object({
  rows: z
    .array(
      z.object({
        rect: z.number().int().describe("Index of the rectangle, from the list given"),
        rows: z
          .array(z.array(z.number().int()))
          .describe("Rows of room indices, smallest y first, and left to right within each row"),
      }),
    )
    .describe("One entry per rectangle, every rectangle used, every room placed exactly once"),
  reasoning: z.string().describe("One sentence on the arrangement chosen. Empty if nothing to say."),
});

function systemPrompt(): string {
  return `You are arranging the rooms of a house inside its real footprint, for a floor plan.

You are given the building's outline already cut into axis-aligned rectangles, and a list of rooms with the area each one typically wants. Your job is to say which rooms go in which rectangle, and how they stack into rows within it.

Coordinates: within a rectangle, row 0 is at the SMALLEST y and rows increase with y. Within a row, items run from smallest x to largest.

How a house is actually arranged, in rough order of how much it matters:

- **Bedrooms cluster.** They go together, away from the living space, usually along one wing or one end. Four bedrooms spread evenly across the front of a house is the single most obvious sign of a plan nobody laid out.
- **A bathroom belongs beside the bedrooms it serves.** An ensuite touches its bedroom. A family bathroom sits among the bedrooms, not off the kitchen.
- **Kitchen, dining and living touch each other.** In anything built in the last fifty years they are one connected zone.
- **The entry and hallway sit where the front door is**, and the hallway is what links the living zone to the bedroom zone. Give it a run rather than a corner.
- **A garage goes on the outside**, on the side its doors face, and touches at most one habitable room.
- **Rooms observed to connect must touch.** You are told which pairs were seen through an opening in the photographs. That is the strongest evidence there is about this specific house; honour it over the general rules above.
- **Utility rooms and closets fill what is left.** They are the ones that tolerate being awkward.

Constraints you must satisfy or the answer is discarded:
- Every room index appears exactly once, across all rectangles.
- Every rectangle gets at least one row, and every row at least one room. An empty rectangle is a hole in the middle of the house.
- Do not exceed the row and column limits given for each rectangle. They follow from the smallest a room is allowed to be, and breaking them produces rooms nobody could stand in.

You are not choosing sizes. Dimensions follow from the area each room wants and the space in its row, so a small room in a big rectangle stays small. Arrange, do not resize.`;
}

export async function GET() {
  return Response.json({ available: Boolean(process.env.ANTHROPIC_API_KEY) });
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "no-api-key" }, { status: 501 });
  }

  let body: {
    rects?: Array<{ widthFt: number; depthFt: number; maxRows: number; maxPerRow: number }>;
    rooms?: Array<{ label: string; wantsSqft: number }>;
    adjacency?: Array<[string, string]>;
    frontDoorBearing?: number | null;
    garageBearing?: number | null;
    planXBearing?: number;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  const rects = body.rects ?? [];
  const rooms = body.rooms ?? [];
  if (rects.length === 0 || rooms.length === 0) {
    return Response.json({ error: "nothing-to-do" }, { status: 400 });
  }

  const described = [
    `The building is cut into ${rects.length} rectangle${rects.length === 1 ? "" : "s"}:`,
    ...rects.map(
      (r, i) =>
        `  [${i}] ${r.widthFt.toFixed(1)}ft wide by ${r.depthFt.toFixed(1)}ft deep - at most ${r.maxRows} row${r.maxRows === 1 ? "" : "s"}, at most ${r.maxPerRow} room${r.maxPerRow === 1 ? "" : "s"} per row`,
    ),
    "",
    `${rooms.length} rooms to place:`,
    ...rooms.map((r, i) => `  [${i}] ${r.label} - typically about ${Math.round(r.wantsSqft)} sqft`),
  ];

  if (body.adjacency?.length) {
    described.push(
      "",
      "Seen connected through an opening in the photographs, so these must touch:",
      ...body.adjacency.map(([a, b]) => `  ${a} - ${b}`),
    );
  }

  /**
   * A bearing, put in terms the arrangement can act on.
   *
   * The plan's axes are not compass axes - the footprint was rotated to square
   * it up - so handing over "the front door is at 85 degrees" would be asking
   * the model to do a coordinate conversion it has no way to check. Which side
   * of the rectangle it lands on is the only part that matters here.
   */
  const side = (bearing: number | null | undefined, what: string): string | null => {
    if (typeof bearing !== "number") return null;
    const relative = (((bearing - (body.planXBearing ?? 90)) % 360) + 360) % 360;
    const where =
      relative < 45 || relative >= 315
        ? "at the largest x"
        : relative < 135
          ? "at the largest y"
          : relative < 225
            ? "at the smallest x"
            : "at the smallest y";
    return `The ${what} is on the side ${where}.`;
  };

  const doors = [
    side(body.frontDoorBearing, "front door"),
    side(body.garageBearing, "garage door"),
  ].filter(Boolean) as string[];
  if (doors.length > 0) described.push("", ...doors);

  try {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 16000,
      // Laying out a house is a judgement about how people live in one rather
      // than a recognition task - the same kind of reasoning as reading a
      // hand-drawn plan, which also runs high.
      output_config: { effort: "high", format: zodOutputFormat(PlanSchema) },
      system: systemPrompt(),
      messages: [{ role: "user", content: described.join("\n") }],
    });

    if (response.stop_reason === "refusal") {
      return Response.json({ error: "refused" }, { status: 422 });
    }
    if (!response.parsed_output) {
      return Response.json({ error: "unparsed" }, { status: 502 });
    }

    // Flattened into the shape `packIntoFootprint` takes: one entry per
    // rectangle, in the order the rectangles were given. A rectangle the model
    // left out becomes an empty entry, which `validatePackPlan` then refuses -
    // better than silently packing a house with a hole in the middle.
    const byRect = new Map(response.parsed_output.rows.map((entry) => [entry.rect, entry.rows]));
    const rows = rects.map((_, i) => byRect.get(i) ?? []);

    return Response.json({ rows, reasoning: response.parsed_output.reasoning });
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
