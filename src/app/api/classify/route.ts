import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/**
 * Look at photos and say which room each one is.
 *
 * This removes the most tedious step in the wizard: tagging thirty photos by
 * hand, one tap at a time. The model is given the house's own room list, so it
 * answers "Primary Bedroom" rather than a generic "Bedroom" that cannot tell
 * three of them apart.
 *
 * The prompt discipline is borrowed from the wholesaling repo's vision scan,
 * where two guardrails that look like cruft turned out to be load-bearing: a
 * hard instruction against inventing what is not visible, and an explicit rule
 * for the ambiguous case. Both apply here - a hallway shot and a bedroom shot
 * of the same beige wall are genuinely hard, and a confident wrong answer is
 * worse than an admitted uncertain one, because the user will not check it.
 */

const MAX_IMAGES = 8;

/**
 * Photos are addressed by position, not by id.
 *
 * They were addressed by id at first, and it produced confidently wrong
 * results: the caller's ids are opaque and differ by a single character
 * (`pmf3k2a0`, `pmf3k2a1`), so labels landed on neighbouring photos and the
 * output looked plausible while being shuffled. Positions are unambiguous, and
 * the mapping back to ids happens here where it cannot be got wrong.
 */
const AssignmentSchema = z.object({
  assignments: z.array(
    z.object({
      index: z.number().int().describe("1-based position of the photo, as labelled"),
      room: z.string().describe("A room name from the provided list"),
      confidence: z
        .enum(["high", "low"])
        .describe("low when the photo is ambiguous or could be one of several rooms"),
      sameRoomAsIndex: z
        .number()
        .int()
        .nullable()
        .describe("position of an earlier photo showing this same physical room, else null"),
      connectsTo: z
        .array(z.string())
        .describe(
          "Other rooms visible from here through a doorway or opening. Empty if none are.",
        ),
    }),
  ),
});

function systemPrompt(rooms: string[]): string {
  return `You are labelling real estate photos with which room of a specific house each one shows.

The house has these rooms:
${rooms.map((r) => `- ${r}`).join("\n")}

Rules:
- Choose a room from that list. Only use a name outside it if nothing in the list could possibly fit.
- Photos of the same physical room must get the same label. Set sameRoomAsIndex to the position of the first photo you assigned that room, so they can be grouped.
- Distinguish bedrooms by what is actually visible — a larger room, an ensuite door, or a bigger bed suggests the primary. If two bedroom photos are indistinguishable, give them different numbered bedrooms rather than collapsing them into one.
- Exterior shots, gardens, streets and drone views are "Outside".
- Do not infer from what a room "should" contain. Label what is in the frame.
- connectsTo: name any other room you can actually see into from this one, through a doorway, archway or open plan gap. A kitchen photo showing a dining table beyond an opening connects to the Dining Room. This is what tells us how the house fits together, so it is worth looking for — but only report what is genuinely visible through an opening, not what you assume is next door.
- Set confidence to "low" whenever the photo could reasonably be more than one room — an empty corner, a close-up of a fixture, a corridor. A wrong label with high confidence will not get checked; a low one will.`;
}

export async function GET() {
  return Response.json({ available: Boolean(process.env.ANTHROPIC_API_KEY) });
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "no-api-key" }, { status: 501 });
  }

  let body: { rooms?: string[]; images?: Array<{ id: string; dataUrl: string }> };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  const rooms = Array.isArray(body.rooms) ? body.rooms.filter((r) => typeof r === "string") : [];
  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];

  if (rooms.length === 0 || images.length === 0) {
    return Response.json({ error: "nothing-to-do" }, { status: 400 });
  }

  const content: Anthropic.ContentBlockParam[] = [];
  // Positions are assigned here and echoed back, so a caller id never has to
  // survive a round trip through the model.
  const order: string[] = [];

  for (const image of images) {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(image.dataUrl ?? "");
    if (!match) continue;
    order.push(image.id);
    content.push({ type: "text", text: `Photo ${order.length}:` });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: match[1] as "image/jpeg" | "image/png" | "image/webp",
        data: match[2],
      },
    });
  }

  if (content.length === 0) {
    return Response.json({ error: "no-valid-images" }, { status: 400 });
  }

  content.push({
    type: "text",
    text: `Label all ${order.length} photos above. Return exactly one assignment per photo, using its number.`,
  });

  try {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 16000,
      // Recognising a kitchen is not hard; the effort is better spent on the
      // handful of genuinely ambiguous shots, which adaptive thinking handles.
      output_config: { effort: "low", format: zodOutputFormat(AssignmentSchema) },
      system: systemPrompt(rooms),
      messages: [{ role: "user", content }],
    });

    if (response.stop_reason === "refusal") {
      return Response.json({ error: "refused" }, { status: 422 });
    }
    if (!response.parsed_output) {
      return Response.json({ error: "unparsed" }, { status: 502 });
    }

    // Map positions back to the caller's ids, dropping anything out of range
    // rather than silently attaching a label to the wrong photo.
    const assignments = response.parsed_output.assignments
      .filter((a) => a.index >= 1 && a.index <= order.length)
      .map((a) => ({
        id: order[a.index - 1],
        room: a.room,
        connectsTo: (a.connectsTo ?? []).filter((r) => r && r !== a.room),
        confidence: a.confidence,
        sameRoomAs:
          a.sameRoomAsIndex && a.sameRoomAsIndex >= 1 && a.sameRoomAsIndex <= order.length
            ? order[a.sameRoomAsIndex - 1]
            : null,
      }));

    return Response.json({ assignments });
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
