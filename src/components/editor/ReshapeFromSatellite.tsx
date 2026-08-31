"use client";

import { useCallback, useMemo, useState } from "react";

import { type ReshapeProposal, proposeReshape } from "@/lib/plan/reshape-client";
import { TRACE_FRAME_PX, ringToPixels } from "@/lib/site/trace";
import { GOOGLE_ATTRIBUTION, metresPerPixel, zoomForExtent } from "@/lib/site/geo";
import { roomKind } from "@/lib/plan/room-kind";
import type { Property } from "@/lib/schema";
import { formatArea } from "@/lib/units";

/**
 * Give a finished tour the shape its house actually has.
 *
 * Tours built before the satellite trace existed had their rooms packed into a
 * rectangle invented from the floor area, so a single-storey ranch came out as
 * a grid of bands. Everything needed to do better is already known - the tour
 * stores where it is - so this re-runs the shape-finding a fresh build now does
 * and offers the result.
 *
 * It shows its work rather than just doing it. The satellite frame is put on
 * screen with the outline drawn over it, because "is that the right building?"
 * is a question only a person can answer and this rearranges their floor plan
 * on the strength of it. Nothing is written until they say so.
 */

/** The extent the tile route frames at, mirrored so the overlay lines up. */
const EXTENT_M = 30;

type State =
  | { at: "idle" }
  | { at: "working"; step: string }
  | { at: "ready"; proposal: ReshapeProposal }
  | { at: "failed"; why: string };

const SOURCE_WORDS: Record<ReshapeProposal["source"], string> = {
  map: "Surveyed outline from OpenStreetMap",
  traced: "Traced from the satellite photograph",
  invented: "A typical shape — neither the map nor the satellite would commit",
};

export function ReshapeFromSatellite({
  property,
  onApply,
}: {
  property: Property;
  onApply: (next: Property) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ at: "idle" });

  const site = property.site;

  const run = useCallback(async () => {
    setState({ at: "working", step: "Starting" });
    try {
      const result = await proposeReshape(property, (step) => setState({ at: "working", step }));
      if ("error" in result) {
        setState({
          at: "failed",
          why:
            result.error === "no-location"
              ? "This tour has no address on it, so there is nowhere to look."
              : result.error === "no-rooms"
                ? "There are no rooms to rearrange yet."
                : "No shape could be found for this address.",
        });
        return;
      }
      setState({ at: "ready", proposal: result });
    } catch (error) {
      setState({
        at: "failed",
        why: error instanceof Error ? error.message : "Something went wrong.",
      });
    }
  }, [property]);

  if (!site) return null;

  return (
    <div className="border-t border-ink-600 pt-3">
      <button
        type="button"
        onClick={() => {
          setOpen((was) => !was);
          if (!open && state.at === "idle") void run();
        }}
        className="w-full rounded border border-ink-500 px-3 py-2 text-xs text-mist-200 hover:bg-ink-600"
      >
        Reshape from satellite
      </button>

      {open && (
        <div className="mt-3 space-y-3 text-xs">
          {state.at === "working" && <p className="text-mist-400">{state.step}…</p>}

          {state.at === "failed" && (
            <div className="space-y-2">
              <p className="text-mist-400">{state.why}</p>
              <button
                type="button"
                onClick={() => void run()}
                className="rounded border border-ink-500 px-3 py-1.5 text-mist-200 hover:bg-ink-600"
              >
                Try again
              </button>
            </div>
          )}

          {state.at === "ready" && (
            <Proposal
              proposal={state.proposal}
              site={site}
              onApply={() => {
                onApply(state.proposal.next);
                setOpen(false);
                setState({ at: "idle" });
              }}
              onRedo={() => void run()}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Proposal({
  proposal,
  site,
  onApply,
  onRedo,
}: {
  proposal: ReshapeProposal;
  site: { lat: number; lon: number };
  onApply: () => void;
  onRedo: () => void;
}) {
  // The same arithmetic the server framed the tile with. Both sides derive it
  // from the shared pure helpers rather than passing a number around, so the
  // overlay cannot drift out of register with the photograph under it.
  const outline = useMemo(() => {
    const zoom = zoomForExtent(site.lat, EXTENT_M);
    const mpp = metresPerPixel(site.lat, zoom);
    return ringToPixels(proposal.ring, site, mpp)
      .map(([u, v]) => `${u.toFixed(1)},${v.toFixed(1)}`)
      .join(" ");
  }, [proposal.ring, site]);

  return (
    <>
      <div className="space-y-2">
        <div className="text-mist-400">{SOURCE_WORDS[proposal.source]}.</div>
        {proposal.why && proposal.source !== "map" && (
          <div className="text-mist-400">Because {proposal.why}.</div>
        )}

        {/* The photograph, with the outline on it. The point of showing this is
            that the two ways a trace goes wrong - the garage, and the whole
            parcel - are obvious to a person and invisible to every check. */}
        {proposal.source !== "invented" && (
          <figure className="overflow-hidden rounded border border-ink-600">
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/site/tile?lat=${site.lat}&lon=${site.lon}&extent=${EXTENT_M}`}
                alt="Satellite view of the property"
                className="block w-full"
              />
              <svg
                viewBox={`0 0 ${TRACE_FRAME_PX} ${TRACE_FRAME_PX}`}
                className="absolute inset-0 h-full w-full"
                aria-hidden
              >
                <polygon
                  points={outline}
                  fill="rgba(255,209,102,0.22)"
                  stroke="#ffd166"
                  strokeWidth={6}
                />
              </svg>
            </div>
            <figcaption className="px-2 py-1 text-[10px] text-mist-400">
              {GOOGLE_ATTRIBUTION}
            </figcaption>
          </figure>
        )}

        <PlanPreview property={proposal.next} />

        <div className="text-mist-400">
          {formatArea(proposal.areaSqft * 0.092903, "ft")} footprint ·{" "}
          {proposal.next.plan.rooms.length} rooms
        </div>

        {proposal.reasoning && <p className="leading-relaxed text-mist-400">{proposal.reasoning}</p>}

        {/* Both should be empty, because the layout is run over this tour's own
            room list. Said out loud anyway - a room quietly appearing or being
            left behind is exactly the kind of thing to find out about now. */}
        {proposal.added.length > 0 && (
          <p className="text-accent">Adds: {proposal.added.join(", ")}.</p>
        )}
        {proposal.dropped.length > 0 && (
          <p className="text-accent">
            No new place for {proposal.dropped.join(", ")} — kept where they are.
          </p>
        )}

        <p className="leading-relaxed text-mist-400">
          Photos and condition grades stay with their rooms. Only the shape and
          where each room sits change.
        </p>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onApply}
          className="rounded bg-accent px-3 py-1.5 font-medium text-ink-900"
        >
          Use this shape
        </button>
        <button
          type="button"
          onClick={onRedo}
          className="rounded border border-ink-500 px-3 py-1.5 text-mist-200 hover:bg-ink-600"
        >
          Look again
        </button>
      </div>
    </>
  );
}

/** The proposed plan, small, purely so the shape can be seen before it lands. */
function PlanPreview({ property }: { property: Property }) {
  const rooms = property.plan.rooms.filter((r) => r.level === 0);
  if (rooms.length === 0) return null;

  const points = rooms.flatMap((r) => r.polygon);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0 || 1;
  const h = Math.max(...ys) - y0 || 1;
  const pad = Math.max(w, h) * 0.04;

  return (
    <svg
      viewBox={`${x0 - pad} ${y0 - pad} ${w + pad * 2} ${h + pad * 2}`}
      className="block w-full rounded border border-ink-600 bg-ink-900"
      style={{ aspectRatio: `${w} / ${h}` }}
    >
      {rooms.map((room) => (
        <polygon
          key={room.id}
          points={room.polygon.map((p) => `${p[0]},${p[1]}`).join(" ")}
          // The garden is drawn differently because it is not part of the
          // house, and a solid block of it reads as another room.
          fill={roomKind(room.label) === "outside" ? "rgba(120,140,120,0.18)" : "rgba(255,209,102,0.14)"}
          stroke={roomKind(room.label) === "outside" ? "#6b7d6b" : "#ffd166"}
          strokeWidth={Math.max(w, h) / 320}
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
