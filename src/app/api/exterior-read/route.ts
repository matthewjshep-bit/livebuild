import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { outputConfig, policyFor } from "@/lib/ai/policy";
import { z } from "zod";

import { reconcileExterior } from "@/lib/site/exterior-read";

/**
 * Read what the outside of a house is made of, from its owner's photographs.
 *
 * The site read looks at the satellite and the street-level imagery a map
 * service holds, and is right about the roof's shape and wrong, often, about
 * its colour. This looks at the photographs the owner took standing in front
 * of the house, which show the siding, the roof covering, the trim, the door
 * and the garden as they are. The room read's discipline applies: describe
 * the thing under daylight, not the light; an empty answer is a good one.
 *
 * The schema is small on purpose. A structured output's schema is compiled to
 * a grammar with a size limit, every nullable is an `anyOf`, and the room
 * read has already found the edge of it. So: plain strings, empty for unknown,
 * the vocabulary in the description where the SDK puts an enum anyway, and
 * one list of contents that the route sorts.
 */

export const maxDuration = 120;

const MAX_PHOTOS = 5;

const ReadSchema = z.object({
  sidingMaterial: z
    .string()
    .describe("What the walls are clad in: lap siding, shingle, brick, stucco, board and batten, stone... Empty if unclear"),
  sidingColour: z.string().describe("#rrggbb of the cladding under daylight, or empty"),
  roofShape: z.string().describe("One of: gable, hip, flat, shed, gambrel, mansard, pyramidal, complex. Empty if unclear"),
  roofMaterial: z.string().describe("asphalt shingle, metal, tile, slate, shake... Empty if unclear"),
  roofColour: z.string().describe("#rrggbb of the roof covering - not the sky - or empty"),
  trimColour: z.string().describe("#rrggbb of the window and door trim, or empty"),
  doorColour: z.string().describe("#rrggbb of the front door, or empty"),
  contents: z
    .array(
      z.object({
        kind: z
          .string()
          .describe("One of: porch, steps, driveway, path, fence, hedge, tree, shrub, lawn, garage, shed, deck, patio"),
        material: z.string().describe("brick, concrete, asphalt, gravel, timber, evergreen... or empty"),
        colour: z.string().describe("#rrggbb, or empty"),
        where: z
          .string()
          .describe("Relative to the front door as you face the house: left, right, in front, along the street, behind, both sides - or empty"),
        size: z.string().describe("small, medium, large - or empty"),
      }),
    )
    .describe("What is outside: fitted things and planting. One entry per tree. Empty when there is nothing to report."),
  confidence: z.enum(["high", "low"]),
  notes: z.string().describe("Anything worth saying, or empty"),
});

const SYSTEM = `You read what the outside of a house is made of, from photographs its owner took of it, so that a 3D replica can be built.

Describe the building first: what the walls are clad in and what colour, what the roof is covered in and what colour and what shape, the colour of the trim round the windows and doors, and the front door. Then list what is outside it - a porch, steps, a driveway and what it is paved with, a path, a fence, a hedge, each tree, shrubs, a lawn, a detached garage or shed, a deck or patio - each with where it is as you face the house from the street, and roughly how big.

Rules:
- Colours are of the thing, not of the light. Photographs are shot in sun and shade and at every hour; report what the surface would be under flat daylight. If a colour cannot be judged, leave it empty.
- The roof colour is the covering, not the sky, and not the shadow side.
- Do not infer a garage from a driveway, or a lawn from a house. Report only what you can see.
- One entry per tree, up to six. Shrubs by the bed, not by the plant.
- Empty is a correct answer. A list with nothing in it means you saw nothing to report.`;

export async function GET() {
  return Response.json({ available: Boolean(process.env.ANTHROPIC_API_KEY) });
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "no-api-key" }, { status: 501 });
  }

  let body: {
    photos?: string[];
    /** What the map already said, so the reader can confirm or correct it. */
    hints?: { roofShape?: string | null; storeys?: number | null };
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  const photos = (body.photos ?? []).slice(0, MAX_PHOTOS);
  const hints = [
    body.hints?.storeys ? `${body.hints.storeys} storeys` : null,
    body.hints?.roofShape ? `a ${body.hints.roofShape} roof` : null,
  ].filter(Boolean);
  const context =
    `These are photographs of the outside of one house.` +
    (hints.length ? ` A map says it has ${hints.join(" and ")}; say if the photographs disagree.` : "");

  const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: context }];
  let attached = 0;
  for (const [i, photo] of photos.entries()) {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(photo);
    if (!match) continue;
    attached++;
    content.push({ type: "text", text: `Photo ${i + 1}:` });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: match[1] as "image/jpeg" | "image/png" | "image/webp",
        data: match[2],
      },
    });
  }
  if (attached === 0) {
    return Response.json({ error: "no-photos" }, { status: 400 });
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: policyFor("exterior-read").model,
      max_tokens: policyFor("exterior-read").maxTokens,
      output_config: outputConfig("exterior-read", zodOutputFormat(ReadSchema)),
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
    });

    if (response.stop_reason === "refusal") {
      return Response.json({ error: "refused" }, { status: 422 });
    }
    if (!response.parsed_output) {
      return Response.json({ error: "unparsed" }, { status: 502 });
    }
    return Response.json(reconcileExterior(response.parsed_output));
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return Response.json({ error: "bad-key" }, { status: 401 });
    }
    if (error instanceof Anthropic.RateLimitError) {
      return Response.json({ error: "rate-limited" }, { status: 429 });
    }
    if (error instanceof Anthropic.APIError) {
      return Response.json({ error: "api", status: error.status, message: error.message }, { status: 502 });
    }
    return Response.json({ error: "unknown" }, { status: 500 });
  }
}
