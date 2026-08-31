"use client";

import { useCallback, useRef, useState } from "react";

import { PhotoDrop, type ImportedPhoto } from "@/components/wizard/PhotoDrop";
import { PhotoReview } from "@/components/wizard/PhotoReview";
import {
  type BuildStep,
  labelPhotos,
  placePhotos,
  posePhotos,
  roomHints,
} from "@/lib/build/pipeline";
import { carryCondition } from "@/lib/build/carryover";
import { deleteMedia, mediaRef, putMedia, refToKey } from "@/lib/media-store";
import { layoutFromSpec } from "@/lib/plan/autolayout";
import type { Plan, Property } from "@/lib/schema";

/**
 * Photographs, after the house already exists.
 *
 * Every part of this ran once already, in the wizard, and could never be run
 * again: the classify pass, the placement and the pose refinement were all
 * reachable only from `/new`. So a tour that came out with
 * no photographs - an address whose listing had no gallery, a scrape that failed
 * on the day - was finished. The only way to add a photograph afterwards was to
 * place a viewpoint by hand, upload a file to it, and aim it yourself, one at a
 * time.
 *
 * Two ways in, and the difference between them is what is at stake rather than
 * what is convenient. Adding leaves the plan and its grading exactly alone.
 * Rebuilding re-derives the layout from everything now known, which is more
 * powerful and which renames every room - so it says so first, and carries the
 * grading across rather than dropping it.
 */
export function AddPhotos({
  property,
  onUpdate,
}: {
  property: Property;
  onUpdate: (property: Property) => void;
}) {
  const [open, setOpen] = useState(false);
  const [photos, setPhotos] = useState<ImportedPhoto[]>([]);
  const [step, setStep] = useState<BuildStep | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const busy = step !== null;

  const addFiles = useCallback(
    async (files: File[]) => {
      const added: ImportedPhoto[] = [];
      for (let i = 0; i < files.length; i++) {
        // Keyed under the property, matching what the wizard writes, so a photo
        // added here is indistinguishable from one imported at build time.
        const id = `p${Date.now().toString(36)}${i}`;
        const key = `${property.id}/${id}/photo`;
        await putMedia(key, files[i]);
        added.push({
          id,
          name: files[i].name,
          file: files[i],
          ref: mediaRef(key),
          url: URL.createObjectURL(files[i]),
          roomLabel: null,
        });
      }
      setPhotos((current) => [...current, ...added]);
    },
    [property.id],
  );

  /**
   * The rooms to offer the classifier.
   *
   * This house's own labels, and for adding, *only* those. The classify route
   * takes a room list precisely so it answers "Bedroom 2" rather than a generic
   * "Bedroom" that cannot tell three of them apart - and handing it the generic
   * preset list instead is worse than useless here: it confidently labelled a
   * photograph "Living Room" for a house that has no living room, and the
   * photograph then matched nothing and was silently left out.
   *
   * Rebuilding is the opposite case and gets the presets too, because a room
   * the house does not have yet is exactly what that button is for.
   */
  const hintsFor = useCallback(
    (discovering: boolean) => {
      const own = property.plan.rooms.map((r) => r.label);
      return discovering ? [...own, ...roomHints(null).filter((r) => !own.includes(r))] : own;
    },
    [property.plan.rooms],
  );

  /** Everything both paths do: label the photographs, and attach them to rooms. */
  const ingest = useCallback(
    async (plan: Plan, base: Property, keepExisting: boolean) => {
      const gathered: string[] = [];

      const read = await labelPhotos(photos, hintsFor(false), setStep);
      setPhotos(read.photos);

      const existing = keepExisting ? base.nodes : [];
      const placed = placePhotos(plan, read.photos, existing);
      if (placed.unplaced > 0) {
        gathered.push(
          `${placed.unplaced} photo${placed.unplaced === 1 ? "" : "s"} matched no room here and ${placed.unplaced === 1 ? "was" : "were"} left out — tag ${placed.unplaced === 1 ? "it" : "them"} below, or rebuild to add the room.`,
        );
      }

      let assembled: Property = {
        ...base,
        plan,
        nodes: keepExisting ? [...base.nodes, ...placed.nodes] : placed.nodes,
      };
      onUpdate(assembled);

      // Only the new cameras are re-aimed. The existing ones were already
      // posed, and asking the model about them again would spend a request per
      // photograph to answer a question that has an answer.
      const fresh = placed.nodes.map((n) => n.id);
      const posed = await posePhotos(
        plan,
        assembled.nodes.filter((n) => fresh.includes(n.id)),
        setStep,
      );
      const byId = new Map(posed.nodes.map((n) => [n.id, n]));
      assembled = {
        ...assembled,
        nodes: assembled.nodes.map((n) => byId.get(n.id) ?? n),
      };
      if (posed.refined > 0) {
        gathered.push(
          `Aimed ${posed.refined} camera${posed.refined === 1 ? "" : "s"} from what the photo${posed.refined === 1 ? " shows" : "s show"}.`,
        );
      }
      gathered.unshift(
        `${placed.nodes.length} photo${placed.nodes.length === 1 ? "" : "s"} attached.`,
      );
      onUpdate(assembled);
      setNotes(gathered);
      setStep(null);
      setPhotos([]);
    },
    [photos, onUpdate, hintsFor],
  );

  /** Leave the plan and the grading exactly as they are. */
  const addOnly = useCallback(async () => {
    setNotes([]);
    await ingest(property.plan, property, true);
  }, [ingest, property]);

  /**
   * Re-derive the layout from every photograph, old and new.
   *
   * The room list comes from the labels rather than from the plan, so a
   * photograph of a room the house does not have yet brings that room into
   * existence - which is the whole reason to press this rather than the other
   * button.
   */
  const rebuild = useCallback(async () => {
    setNotes([]);
    setConfirmRebuild(false);

    const read = await labelPhotos(photos, hintsFor(true), setStep);
    setPhotos(read.photos);
    setStep({ label: "Working out the layout", done: 0, total: 1 });

    const labels: string[] = [];
    for (const room of property.plan.rooms) if (!labels.includes(room.label)) labels.push(room.label);
    for (const photo of read.photos) {
      if (photo.roomLabel && !labels.includes(photo.roomLabel)) labels.push(photo.roomLabel);
    }
    const levelOf = new Map(property.plan.rooms.map((r) => [r.label, r.level]));

    const built = layoutFromSpec(
      { rooms: labels.map((label) => ({ label, level: levelOf.get(label) ?? 0 })) },
      undefined,
      read.adjacency,
    );
    const nextPlan: Plan = {
      scaleRef: property.plan.scaleRef,
      rooms: built.rooms,
      openings: built.openings,
    };

    // The grading is the expensive thing in this document and it is keyed by
    // room id, which a re-layout changes. Carry it before anything is written.
    const moved = carryCondition(property.plan, nextPlan, property.condition);
    const carried: Property = { ...property, plan: nextPlan, condition: moved.condition };

    // Every old photograph is re-placed too, since its room no longer exists.
    const oldPhotos = property.nodes.map((node) => ({
      id: node.id,
      ref: node.photo,
      roomLabel: property.plan.rooms.find((r) => r.id === node.roomId)?.label ?? null,
    }));
    const all = [...oldPhotos, ...read.photos.map((p) => ({ id: p.id, ref: p.ref, roomLabel: p.roomLabel }))];
    const placed = placePhotos(nextPlan, all);

    const assembled: Property = { ...carried, nodes: placed.nodes };
    onUpdate(assembled);

    const said: string[] = [
      `${nextPlan.rooms.length} rooms, ${nextPlan.openings.length} doorways, ${assembled.nodes.length} photos.`,
    ];
    if (moved.carried > 0) {
      said.push(`Kept the condition you had graded on ${moved.carried} room${moved.carried === 1 ? "" : "s"}.`);
    }
    if (moved.lost.length > 0) {
      said.push(`Lost the grading on ${moved.lost.join(", ")} — ${moved.lost.length === 1 ? "that room is" : "those rooms are"} no longer in the plan.`);
    }
    setNotes(said);
    setStep(null);
    setPhotos([]);
  }, [photos, property, onUpdate, hintsFor]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full rounded border border-ink-500 px-3 py-2 text-xs text-mist-200 transition hover:bg-ink-600"
      >
        Add photos&hellip;
      </button>
    );
  }

  return (
    <div className="rounded border border-ink-600 bg-ink-800 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium text-mist-200">Add photos</h3>
        <button
          onClick={() => setOpen(false)}
          disabled={busy}
          className="text-xs text-mist-400 hover:text-mist-200 disabled:opacity-40"
        >
          Close
        </button>
      </div>

      <p className="mb-3 text-[11px] leading-relaxed text-mist-400">
        They are read for which room they show, placed, and aimed &mdash; the same way the
        wizard does it.
      </p>

      <PhotoDrop
        photos={photos}
        onAdd={addFiles}
        onRemove={(id) => {
          const photo = photos.find((p) => p.id === id);
          setPhotos((c) => c.filter((p) => p.id !== id));
          if (photo) void deleteMedia(refToKey(photo.ref));
        }}
      />

      {photos.length > 0 && !busy && (
        <div className="mt-3 space-y-2">
          <button
            onClick={() => void addOnly()}
            className="w-full rounded bg-accent px-3 py-2 text-xs font-medium text-ink-900"
          >
            Add {photos.length} photo{photos.length === 1 ? "" : "s"} to this house
          </button>
          <p className="text-[11px] leading-relaxed text-mist-400">
            The plan, the doorways and anything you have graded stay exactly as they are.
          </p>

          {confirmRebuild ? (
            <div className="rounded border border-warn/40 bg-ink-700 p-2">
              <p className="text-[11px] leading-relaxed text-mist-200">
                Rebuilding lays the house out again from every photograph, so rooms the new
                ones reveal get added. It replaces the plan you have now, including any
                rooms you drew or moved by hand. Grading is carried across by room name;
                anything whose room disappears is lost.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => void rebuild()}
                  className="flex-1 rounded border border-warn px-3 py-1.5 text-xs text-warn"
                >
                  Rebuild the layout
                </button>
                <button
                  onClick={() => setConfirmRebuild(false)}
                  className="rounded border border-ink-500 px-3 py-1.5 text-xs text-mist-400"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmRebuild(true)}
              className="w-full text-left text-[11px] text-mist-400 underline underline-offset-4 hover:text-mist-200"
            >
              Or rebuild the layout from everything&hellip;
            </button>
          )}
        </div>
      )}

      {step && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-[11px] text-mist-400">
            <span>{step.label}</span>
            {step.total > 1 && <span>{step.done}/{step.total}</span>}
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-600">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${step.total > 0 ? (step.done / step.total) * 100 : 8}%` }}
            />
          </div>
        </div>
      )}

      {notes.length > 0 && (
        <ul className="mt-3 space-y-1 text-[11px] leading-relaxed text-mist-400">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      {photos.some((p) => p.roomLabel) && !busy && (
        <div className="mt-3 border-t border-ink-600 pt-3">
          <PhotoReview
            photos={photos}
            spec={null}
            onTag={(photoId, roomLabel) =>
              setPhotos((c) =>
                c.map((p) => (p.id === photoId ? { ...p, roomLabel, guessed: undefined } : p)),
              )
            }
          />
        </div>
      )}
    </div>
  );
}
