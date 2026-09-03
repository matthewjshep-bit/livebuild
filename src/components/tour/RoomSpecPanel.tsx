"use client";

import { useState } from "react";

import { verifyRoom, type VerifyOutcome } from "@/lib/spec/verify-client";
import type { CapturePose } from "@/lib/render/capture";

import { type ExteriorSpec, type Source, EMPTY_EXTERIOR_SPEC } from "@/lib/spec/schema";
import { ftToM, mToFt } from "@/lib/units";
import type { Property } from "@/lib/schema";

/**
 * What this room is made of, and how much of it anybody actually saw.
 *
 * The model can only be as right as what was read out of the photographs, and
 * a replica can be confidently wrong in a way a photograph cannot. So the
 * remedy is not to hide the uncertainty but to put it on screen: every value
 * says where it came from, an assumed one says *why* it was assumed, and any of
 * them can be corrected in one click.
 *
 * It sits directly beneath the photographs the room was built from, which is
 * the whole point of the arrangement - the question this answers is "is that
 * really what the kitchen looks like?", and that is a question you ask with the
 * picture in front of you.
 *
 * A hand edit is recorded as `human`, which outranks everything. Neither the
 * inference nor a re-read will touch it again.
 */

const LABEL: Record<Source, string> = {
  human: "you",
  verified: "checked",
  read: "from the photos",
  inferred: "worked out",
  assumed: "assumed",
};

const TONE: Record<Source, string> = {
  human: "text-accent",
  verified: "text-mist-200",
  read: "text-mist-200",
  inferred: "text-mist-400",
  assumed: "text-mist-400",
};

const FLOORS = ["wood", "tile", "stone", "carpet", "concrete", "grass"] as const;

export function RoomSpecPanel({
  property,
  roomId,
  onPropertyChange,
}: {
  property: Property;
  roomId: string | null;
  onPropertyChange?: (property: Property) => void;
}) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<VerifyOutcome | null>(null);

  const room = roomId ? property.plan.rooms.find((r) => r.id === roomId) : null;
  const spec = roomId ? property.spec?.rooms[roomId] : null;
  if (!room || !spec) return null;

  /**
   * Write one field, and mark it as yours.
   *
   * Onto the whole property rather than onto the room, because `spec` lives on
   * the document beside `condition` for the same reason that does: a re-layout
   * regenerates every room, and anything hanging off one would not survive it.
   */
  const edit = (...changes: Array<[string, string | number]>) => {
    if (!onPropertyChange || !property.spec) return;

    // Every change in one update, and that is not tidiness.
    //
    // This took a single path at a time, and read the room's current spec out
    // of the props it was rendered with. Two calls in a row therefore both
    // cloned the *same* pre-edit state and the second silently threw away the
    // first - so choosing a beamed ceiling set the kind, then seeded the beams
    // over the top of it, and the ceiling stayed flat while the panel showed
    // beams. Anything that needs to set two fields at once has to say so.
    const next = structuredClone(property.spec.rooms[room.id]);
    for (const [path, value] of changes) {
      const keys = path.split(".");
      const leaf = keys.pop()!;
      let node = next as unknown as Record<string, unknown>;
      for (const key of keys) {
        if (node[key] === undefined || node[key] === null) node[key] = {};
        node = node[key] as Record<string, unknown>;
      }
      node[leaf] = value;
      next.source[path] = "human";
      delete next.because[path];
    }

    onPropertyChange({
      ...property,
      spec: {
        ...property.spec,
        rooms: { ...property.spec.rooms, [room.id]: next },
      },
    });
  };

  const Origin = ({ path }: { path: string }) => {
    const source = spec.source[path];
    if (!source) return null;
    return (
      <span className={`text-[10px] ${TONE[source]}`} title={spec.because[path] ?? ""}>
        {LABEL[source]}
        {spec.because[path] ? " ⓘ" : ""}
      </span>
    );
  };

  const Row = ({ label, path, children }: { label: string; path: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="shrink-0 text-[11px] text-mist-400">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5">
        {children}
        <Origin path={path} />
      </div>
    </div>
  );

  const inputClass =
    "w-24 rounded border border-ink-500 bg-ink-700 px-1.5 py-0.5 text-[11px] text-mist-200 outline-none focus:border-accent-dim disabled:opacity-60";

  const assumed = Object.values(spec.source).filter(
    (s) => s === "inferred" || s === "assumed",
  ).length;

  // Nothing to check the room against without one.
  const hasPhoto = property.nodes.some((n) => n.roomId === room.id);

  return (
    <div className="mt-1.5" data-room-spec>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full rounded-lg border border-ink-600 bg-ink-800/90 px-3 py-2 text-left text-[11px] text-mist-200 backdrop-blur transition hover:border-ink-500"
      >
        <span className="uppercase tracking-wide text-mist-400">Made of</span>{" "}
        {spec.observed ? (
          <span>read from the photos</span>
        ) : (
          <span className="text-mist-400">worked out — no photo of this room</span>
        )}
        {assumed > 0 && <span className="text-mist-400"> · {assumed} assumed</span>}
        <span className="float-right text-mist-400">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-1.5 rounded-lg border border-ink-600 bg-ink-800/90 px-3 py-2 backdrop-blur">
          <Row label="Floor" path="floor.material">
            <select
              className={inputClass}
              value={spec.floor?.material ?? "wood"}
              disabled={!onPropertyChange}
              onChange={(e) => edit(["floor.material", e.target.value])}
            >
              {FLOORS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </Row>

          <Row label="Floor colour" path="floor.colour">
            <input
              type="color"
              className="h-5 w-8 rounded border border-ink-500 bg-ink-700"
              value={spec.floor?.colour ?? "#c9a875"}
              disabled={!onPropertyChange}
              onChange={(e) => edit(["floor.colour", e.target.value])}
            />
          </Row>

          <Row label="Walls" path="walls.colour">
            <input
              type="color"
              className="h-5 w-8 rounded border border-ink-500 bg-ink-700"
              value={spec.walls?.colour ?? "#f2f1ee"}
              disabled={!onPropertyChange}
              onChange={(e) => edit(["walls.colour", e.target.value])}
            />
          </Row>

          <Row label="Ceiling (ft)" path="ceiling.heightM">
            <input
              type="number"
              step="0.5"
              className={inputClass}
              value={+mToFt(spec.ceiling?.heightM ?? room.ceilingHeight).toFixed(1)}
              disabled={!onPropertyChange}
              onChange={(e) => edit(["ceiling.heightM", ftToM(Number(e.target.value))])}
            />
          </Row>

          <Row label="Ceiling" path="ceiling.kind">
            <select
              className={inputClass}
              value={spec.ceiling?.kind ?? "flat"}
              disabled={!onPropertyChange}
              onChange={(e) =>
                // Beams need a count and a direction to exist at all, and a
                // ceiling that says "beamed" with neither is a flat ceiling
                // claiming otherwise. Seeded in the same update as the kind,
                // because two calls would clobber one another.
                e.target.value === "beamed" && !spec.ceiling?.beams
                  ? edit(
                      ["ceiling.kind", e.target.value],
                      ["ceiling.beams.count", 5],
                      ["ceiling.beams.axis", "x"],
                    )
                  : edit(["ceiling.kind", e.target.value])
              }
            >
              {["flat", "beamed", "tray", "coffered"].map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Row>

          {spec.ceiling?.kind === "beamed" && (
            <Row label="Beams" path="ceiling.beams.count">
              <input
                type="number"
                min={1}
                max={16}
                className={inputClass}
                value={spec.ceiling?.beams?.count ?? 5}
                disabled={!onPropertyChange}
                onChange={(e) => edit(["ceiling.beams.count", Number(e.target.value)])}
              />
            </Row>
          )}

          <Row label="Skirting (in)" path="trim.baseboardM">
            <input
              type="number"
              step="0.5"
              className={inputClass}
              value={+((spec.trim?.baseboardM ?? 0.09) * 39.3701).toFixed(1)}
              disabled={!onPropertyChange}
              onChange={(e) => edit(["trim.baseboardM", Number(e.target.value) / 39.3701])}
            />
          </Row>

          {Object.entries(spec.openings).length > 0 && (
            <div className="mt-1.5 border-t border-ink-600 pt-1.5">
              {Object.entries(spec.openings).map(([otherId, opening]) => {
                const other = property.plan.rooms.find((r) => r.id === otherId);
                if (!other) return null;
                return (
                  <Row key={otherId} label={`To ${other.label}`} path={`openings.${otherId}.kind`}>
                    <select
                      className={inputClass}
                      value={opening.kind}
                      disabled={!onPropertyChange}
                      onChange={(e) => edit([`openings.${otherId}.kind`, e.target.value])}
                    >
                      <option value="door">door</option>
                      <option value="cased">opening</option>
                      <option value="open">no wall</option>
                      <option value="none">none</option>
                    </select>
                  </Row>
                );
              })}
            </div>
          )}

          {/*
            Checking the room against its own photograph.
            
            By hand, one room at a time, and never on its own. This is the only
            pass that can leave a room worse than it found it - everything that
            stops it doing so is arithmetic rather than good intentions, and it
            has still not earned running unattended.
          */}
          {hasPhoto && onPropertyChange && (
            <div className="mt-2 border-t border-ink-600 pt-2">
              <button
                onClick={async () => {
                  const capture = (window as unknown as {
                    __capture?: (pose: CapturePose) => string | null;
                  }).__capture;
                  if (!capture || !property.spec) return;
                  setChecking("Rendering the room as it was photographed");
                  setOutcome(null);
                  const result = await verifyRoom(
                    property,
                    property.spec,
                    room.id,
                    capture,
                    (round, score) =>
                      setChecking(`Round ${round} · ${Math.round(score * 100)}% alike`),
                  );
                  setChecking(null);
                  if (!result) return;
                  setOutcome(result);
                  if (result.applied.length > 0) {
                    onPropertyChange({
                      ...property,
                      spec: {
                        ...property.spec,
                        rooms: { ...property.spec.rooms, [room.id]: result.spec },
                      },
                    });
                  }
                }}
                disabled={Boolean(checking)}
                className="w-full rounded border border-ink-500 px-3 py-1.5 text-[11px] text-mist-200 transition hover:bg-ink-600 disabled:opacity-50"
              >
                {checking ?? "Check against the photos"}
              </button>

              {outcome && (
                <div className="mt-1.5 text-[10px] leading-relaxed text-mist-400">
                  {outcome.poseProblem ? (
                    <span>
                      The render and the photograph are not of the same view
                      {outcome.poseProblem === "none" ? "" : ` (${outcome.poseProblem})`}, so
                      nothing was changed.
                    </span>
                  ) : outcome.applied.length > 0 ? (
                    <span>
                      Corrected {outcome.applied.length}{" "}
                      {outcome.applied.length === 1 ? "thing" : "things"}:{" "}
                      {outcome.applied.map((d) => d.observed).join(", ")}.
                    </span>
                  ) : (
                    <span>
                      Nothing worth changing
                      {outcome.because === "converged"
                        ? " — it already matches."
                        : outcome.because === "no-improvement"
                          ? " — the corrections it wanted did not improve the match."
                          : "."}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {spec.notes && (
            <p className="mt-2 border-t border-ink-600 pt-2 text-[10px] leading-relaxed text-mist-400">
              {spec.notes}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The outside, as a photograph of it was read, with where each value came from.
 *
 * The same rows and the same pill as a room: siding, roof, trim, door, each
 * marked "from the photos" or "you". Edits are marked yours and stick.
 */
export function ExteriorSpecPanel({
  property,
  onPropertyChange,
}: {
  property: Property;
  onPropertyChange?: (property: Property) => void;
}) {
  const [open, setOpen] = useState(false);
  const spec: ExteriorSpec | null | undefined = property.spec?.exterior;
  if (!spec) return null;

  const edit = (path: string, value: string) => {
    if (!onPropertyChange || !property.spec) return;
    const next = structuredClone({ ...EMPTY_EXTERIOR_SPEC, ...spec });
    const keys = path.split(".");
    const leaf = keys.pop()!;
    let node = next as unknown as Record<string, unknown>;
    for (const key of keys) {
      if (node[key] === undefined || node[key] === null) node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    node[leaf] = value;
    next.source[path] = "human";
    delete next.because[path];
    onPropertyChange({ ...property, spec: { ...property.spec, exterior: next } });
  };

  const Origin = ({ path }: { path: string }) => {
    const source = spec.source[path];
    if (!source) return null;
    return (
      <span className={`text-[10px] ${TONE[source]}`} title={spec.because[path] ?? ""}>
        {LABEL[source]}
      </span>
    );
  };
  const Row = ({ label, path, children }: { label: string; path: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="shrink-0 text-[11px] text-mist-400">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5">
        {children}
        <Origin path={path} />
      </div>
    </div>
  );
  const Colour = ({ path, value }: { path: string; value: string | null | undefined }) => (
    <input
      type="color"
      value={value ?? "#888888"}
      disabled={!onPropertyChange}
      onChange={(e) => edit(path, e.target.value)}
      aria-label={path}
      className="h-5 w-8 cursor-pointer rounded border border-ink-500 bg-ink-700 disabled:opacity-60"
    />
  );

  const read = Object.values(spec.source).filter((s) => s === "read").length;
  return (
    <div data-exterior-spec className="mt-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full rounded-lg border border-ink-600 bg-ink-800/90 px-3 py-2 text-left text-[11px] text-mist-200 backdrop-blur transition hover:border-ink-500"
      >
        <span className="uppercase tracking-wide text-mist-400">Outside</span>{" "}
        {spec.observed ? `read from the photos${read ? ` · ${read} ${read === 1 ? "thing" : "things"}` : ""}` : "not photographed"}
        <span className="float-right text-mist-400">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-1.5 rounded-lg border border-ink-600 bg-ink-800/90 px-3 py-2 backdrop-blur">
          <Row label="Siding" path="siding.material">
            <span className="truncate text-[11px] text-mist-200">{spec.siding?.material ?? "—"}</span>
          </Row>
          <Row label="Siding colour" path="siding.colour">
            <Colour path="siding.colour" value={spec.siding?.colour} />
          </Row>
          <Row label="Roof" path="roof.material">
            <span className="truncate text-[11px] text-mist-200">
              {[spec.roof?.shape, spec.roof?.material].filter(Boolean).join(" · ") || "—"}
            </span>
          </Row>
          <Row label="Roof colour" path="roof.colour">
            <Colour path="roof.colour" value={spec.roof?.colour} />
          </Row>
          <Row label="Trim" path="trim.colour">
            <Colour path="trim.colour" value={spec.trim?.colour} />
          </Row>
          <Row label="Front door" path="door.colour">
            <Colour path="door.colour" value={spec.door?.colour} />
          </Row>
          {spec.features.length > 0 && (
            <p className="mt-1 text-[10px] leading-relaxed text-mist-400">
              Outside: {spec.features.map((f) => f.kind).join(", ")}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
