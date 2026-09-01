import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { outputConfig, policyFor } from "@/lib/ai/policy";
import { z } from "zod";

import { ROOM_PRESETS } from "@/lib/plan/autolayout";

/**
 * Optional AI pass over a plain-English house description.
 *
 * The offline parser in `src/lib/plan/describe.ts` is the default and handles
 * the structured phrasing most descriptions use. This exists for genuine prose
 * it cannot crack - "the kitchen opens onto a dining area at the back, with two
 * bedrooms off a corridor on the left" - and returns the identical shape, so
 * the caller can fall back without special-casing anything.
 *
 * Runs server-side only. The key never reaches the browser, and the only thing
 * that leaves the machine is the description text - never a photo.
 */

const HouseSchema = z.object({
  rooms: z
    .array(
      z.object({
        label: z
          .string()
          .describe("Room name, e.g. 'Kitchen', 'Primary Bedroom', 'Bedroom 2'"),
        level: z
          .number()
          .int()
          .describe("Storey: 0 ground floor, 1 upstairs, -1 basement"),
      }),
    )
    .describe("Every room in the house, in the order someone would walk them"),
  notes: z
    .array(z.string())
    .describe("Short phrases summarising what was understood, shown back to the user"),
});

const SYSTEM = `You turn a plain-English description of a house into a room list for a floor-plan builder.

Rules:
- One entry per physical room. Three bedrooms means three entries: "Primary Bedroom", "Bedroom 2", "Bedroom 3" (use "Bedroom 1" instead of "Primary Bedroom" only if no primary/master is implied).
- Bathrooms: "2.5 bath" means two full bathrooms plus a "Powder Room". A bathroom attached to the primary bedroom is "Primary Ensuite".
- level: 0 for the ground floor, 1 for upstairs, -1 for a basement. In a two-storey house put bedrooms and their bathrooms upstairs, and living/kitchen/dining/garage on the ground floor, unless the description says otherwise.
- Always include a "Hallway" on every storey that has rooms — it is what connects them, and people never mention it.
- If there is more than one storey, include a "Stairs" room on each storey. Stairs are how the floors connect.
- Include a "Kitchen" and a "Living Room" even if unmentioned; a description is a summary, not an inventory.
- Do not invent rooms the description does not imply. No guessing at square footage.
- Prefer these labels where they fit: ${ROOM_PRESETS.join(", ")}. Other labels are allowed when the description names something else.
- notes: two to four short phrases stating what you understood ("4 bedrooms, one primary", "two storeys"), so a misreading is obvious to the user.`;

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    // Not an error: the caller is expected to use its own parser instead.
    return Response.json(
      { error: "no-api-key", message: "Set ANTHROPIC_API_KEY in .env.local to enable this." },
      { status: 501 },
    );
  }

  let text: string;
  try {
    const body = await request.json();
    text = typeof body?.text === "string" ? body.text.trim() : "";
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  if (text.length < 3) {
    return Response.json({ error: "empty" }, { status: 400 });
  }
  if (text.length > 4000) {
    // A house description is a paragraph. Anything longer is a mistake, and
    // truncating silently would be worse than refusing.
    return Response.json({ error: "too-long" }, { status: 413 });
  }

  try {
    const client = new Anthropic();

    const response = await client.messages.parse({
      model: policyFor("describe").model,
      max_tokens: policyFor("describe").maxTokens,
      // A structured extraction from one paragraph; low effort is ample and
      // keeps the step feeling instant.
      output_config: outputConfig("describe", zodOutputFormat(HouseSchema)),
      system: SYSTEM,
      messages: [{ role: "user", content: text }],
    });

    if (response.stop_reason === "refusal") {
      return Response.json({ error: "refused" }, { status: 422 });
    }

    const parsed = response.parsed_output;
    if (!parsed) {
      return Response.json({ error: "unparsed" }, { status: 502 });
    }

    return Response.json({ ...parsed, source: "ai" });
  } catch (error) {
    // Every failure here is recoverable by the offline parser, so report it
    // plainly and let the client decide rather than dressing it up.
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
