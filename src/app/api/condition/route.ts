import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { GRADES } from "@/lib/bom/condition";

/**
 * Grade what a room is currently in, from its photos.
 *
 * The bill of materials multiplies quantities from the model by rates from the
 * card; condition is what decides which lines exist at all. Getting it from the
 * photos means a scope of work falls out of a listing rather than out of a site
 * visit.
 *
 * Two things this deliberately does not do. It does not guess: an element no
 * photo shows comes back `not_visible`, which the BOM costs as nothing and
 * flags, because a room quietly costed as ruined is wrong, expensive and
 * invisible. And it does not price anything - it reports state, and the catalog
 * decides what that state costs.
 */

const MAX_PHOTOS = 6;

const ConditionSchema = z.object({
  grades: z.array(
    z.object({
      element: z.string().describe("One of the elements you were asked about"),
      grade: z.enum(GRADES),
      reason: z.string().describe("A few words on what you saw. Empty if not visible."),
    }),
  ),
  notes: z.string().describe("Anything notable about the room's condition, or empty"),
});

const SYSTEM = `You grade the current condition of a room from photographs, for a renovation scope of work.

Use exactly these grades:
- good — recently done or as-new. No work needed.
- fair — serviceable and unremarkable. No work needed.
- dated — sound and functional, but the style or finish is old. Needs refreshing, not replacing.
- poor — damaged, failing, missing, or worn out. Needs replacing.
- not_visible — no photograph shows this well enough to judge.

The distinction between dated and poor decides the money, so be careful with it. Oak cabinets from 1995 in working order are *dated*. Cabinets with water damage, missing doors or failing hinges are *poor*. A clean but unfashionable bathroom is dated; a cracked tub is poor.

Rules:
- Judge only what you can see. If an element is out of frame, cut off, or too dark to assess, say not_visible. Do not infer a kitchen's appliances from its cabinets, or a floor's condition from a rug.
- Do not be generous and do not be harsh. This drives a real cost estimate in both directions: grading everything poor invents work, grading everything good hides it.
- Staged or empty rooms are common. An empty room is not a room in poor condition.
- reason: a few words on what you actually saw — "oak doors, brass hardware, sound", "chipped tile at the threshold". Leave empty for not_visible.
- Return one entry per element you were asked about, and no others.`;

export async function GET() {
  return Response.json({ available: Boolean(process.env.ANTHROPIC_API_KEY) });
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "no-api-key" }, { status: 501 });
  }

  let body: {
    room?: string;
    elements?: string[];
    photos?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  const room = String(body.room ?? "").trim();
  const elements = (body.elements ?? []).filter((e) => typeof e === "string");
  const photos = (body.photos ?? []).slice(0, MAX_PHOTOS);

  if (!room || elements.length === 0) {
    return Response.json({ error: "nothing-to-do" }, { status: 400 });
  }

  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text:
        photos.length > 0
          ? `This is the ${room}. Grade these elements: ${elements.join(", ")}.`
          : `This is the ${room}, but no photographs are available.`,
    },
  ];

  for (const dataUrl of photos) {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
    if (!match) continue;
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: match[1] as "image/jpeg" | "image/png" | "image/webp",
        data: match[2],
      },
    });
  }

  // With no usable photo there is nothing to look at, and the honest answer is
  // available without spending a request on it.
  if (content.length === 1) {
    return Response.json({
      grades: elements.map((element) => ({ element, grade: "not_visible", reason: "" })),
      notes: "",
    });
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 16000,
      // Telling dated from poor is a judgement that decides thousands of
      // dollars a room, and it is not a glance.
      output_config: { effort: "high", format: zodOutputFormat(ConditionSchema) },
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });

    if (response.stop_reason === "refusal") {
      return Response.json({ error: "refused" }, { status: 422 });
    }
    if (!response.parsed_output) {
      return Response.json({ error: "unparsed" }, { status: 502 });
    }

    // Only elements that were asked about, so an invented one cannot reach the
    // stored condition and start pricing work on a fitting the room lacks.
    const allowed = new Set(elements);
    return Response.json({
      grades: response.parsed_output.grades.filter((g) => allowed.has(g.element)),
      notes: response.parsed_output.notes,
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
