"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DescribeHouse } from "@/components/wizard/DescribeHouse";
import { PhotoDrop, type ImportedPhoto } from "@/components/wizard/PhotoDrop";
import { PropertyStart } from "@/components/wizard/PropertyStart";
import { PhotoReview } from "@/components/wizard/PhotoReview";
import { PlanBuilder } from "@/components/wizard/PlanBuilder";
import { DepthEstimator, type DepthProgress } from "@/lib/depth/client";
import {
  type BuildStep,
  estimateDepth,
  labelPhotos,
  placePhotos,
  posePhotos,
  roomHints,
} from "@/lib/build/pipeline";
import {
  factsToDescription,
  type ListingFacts,
  type ListingFootprint,
  type ListingResult,
} from "@/lib/listing/types";
import { deleteMedia, refToKey } from "@/lib/media-store";
import { readExterior } from "@/lib/site/client";
import { mergeExterior } from "@/lib/site/osm";
import { layoutFromSpec } from "@/lib/plan/autolayout";
import { layoutFromFootprint, prepareFootprint } from "@/lib/plan/footprint";
import { type HouseSpec, describeToSpec } from "@/lib/plan/describe";
import { saveProperty } from "@/lib/property-store";
import type { Exterior, Plan, Property } from "@/lib/schema";
import { requestPersistence } from "@/lib/storage/db";
import {
  type Draft,
  clearDraft,
  loadDraft,
  resolveDraftUrls,
  saveDraft,
  storeDraftPhoto,
} from "@/lib/storage/drafts";
import { M_PER_FT, sqftToM2 } from "@/lib/units";

/**
 * Three screens, and the middle one runs itself.
 *
 * This was five steps, each asking for something: label every photo, describe
 * the house, arrange the rooms. Every one of those is now inferable from the
 * photos, so the flow asks for photos and then shows what it built. The user
 * corrects rather than authors, which is a far smaller job and a much better
 * first impression.
 */
type Stage = "photos" | "building" | "review";

function newPropertyId(): string {
  const now = new Date();
  return `home-${now.toISOString().slice(0, 10)}-${now.getHours()}${String(
    now.getMinutes(),
  ).padStart(2, "0")}`;
}

export default function NewTourPage() {
  const [stage, setStage] = useState<Stage>("photos");
  const [photos, setPhotos] = useState<ImportedPhoto[]>([]);
  const [propertyId, setPropertyId] = useState(newPropertyId);
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [spec, setSpec] = useState<HouseSpec | null>(null);
  const [facts, setFacts] = useState<ListingFacts | null>(null);
  // The building's real outline, when OpenStreetMap had one for the address.
  const [footprint, setFootprint] = useState<ListingFootprint | null>(null);
  /** Parcel coordinates from the listing, for the sun. */
  const [listingSite, setListingSite] = useState<{ lat: number; lon: number } | null>(null);
  /** What the map recorded about the outside - storeys, roof, materials. */
  const [exterior, setExterior] = useState<Exterior | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [property, setProperty] = useState<Property | null>(null);

  const [step, setStep] = useState<BuildStep | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [depth, setDepth] = useState<DepthProgress>({ stage: "idle", completed: 0, total: 0 });

  const [restoring, setRestoring] = useState(true);
  const [resumable, setResumable] = useState<Draft | null>(null);
  const estimatorRef = useRef<DepthEstimator | null>(null);

  /**
   * Rooms seen through an opening from another room, from the last labelling
   * pass. Kept in a ref rather than state because nothing renders it, and it
   * has to survive into the same run that produced it.
   *
   * It used to be stashed on the `build` callback object itself, which quietly
   * misbehaved on the second press: labelling is skipped when every photo
   * already has a room, so "Rebuild from the photos" reused whatever the
   * previous run happened to leave there - or lost it, if `useCallback` had
   * handed out a new function since.
   */
  const adjacencyRef = useRef<Array<[string, string]>>([]);

  useEffect(() => () => estimatorRef.current?.dispose(), []);
  useEffect(() => {
    void requestPersistence();
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadDraft().then((draft) => {
      if (cancelled) return;
      if (draft && draft.photos.length > 0) setResumable(draft);
      setRestoring(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const addPhotos = useCallback(
    async (files: File[]) => {
      const added: ImportedPhoto[] = [];
      for (let i = 0; i < files.length; i++) {
        const id = `p${Date.now().toString(36)}${i}`;
        const record = await storeDraftPhoto(propertyId, id, files[i]);
        added.push({
          id,
          name: files[i].name,
          file: files[i],
          ref: record.ref,
          url: URL.createObjectURL(files[i]),
          roomLabel: null,
        });
      }
      setPhotos((current) => [...current, ...added]);
    },
    [propertyId],
  );

  const importListing = useCallback(
    async (files: File[], listing: ListingResult) => {
      await addPhotos(files);
      setFacts(listing.facts);
      setFootprint(listing.footprint);
      setListingSite(listing.location);
      setExterior(listing.exterior ?? null);
      if (!label && listing.address) setLabel(listing.address);

      // Only describe the house when the listing actually said something about
      // it. With every fact null, `factsToDescription` returns the bare word
      // "house", which the parser dutifully reads as a kitchen and a living
      // room - and a three-room house is a worse answer than admitting we do
      // not know, because it looks like a considered one.
      const saidSomething =
        Boolean(listing.facts.beds || listing.facts.baths || listing.facts.sqft) ||
        Boolean(listing.remarks);
      if (saidSomething) {
        // The storey count is usually absent from the listing and worked out
        // instead from its floor area against the building's footprint. It
        // matters here rather than only for scale: it is what puts the bedrooms
        // upstairs instead of spreading them across one enormous floor.
        // A surveyed storey count wins outright. This is also the only moment
        // it can matter: the levels go into the spec here, and by the time
        // `build` runs they are already decided.
        const storeys =
          listing.exterior?.storeys ??
          Math.max(listing.footprint?.storeys ?? 1, Math.round(listing.facts.stories ?? 1));
        const sentence = factsToDescription(
          { ...listing.facts, stories: storeys > 1 ? storeys : listing.facts.stories },
          listing.remarks,
        );
        setDescription(sentence);
        setSpec(describeToSpec(sentence));
      }
    },
    [addPhotos, label],
  );

  const tagged = useMemo(() => photos.filter((p) => p.roomLabel), [photos]);

  /**
   * What the lookup found, in the user's own terms.
   *
   * The build is about to spend a minute on this, and an address is a much
   * weaker commitment than a folder of photographs - so it has to be visible
   * that the right house was found before anyone presses go.
   */
  const found = useMemo(() => {
    const items: string[] = [];
    if (facts?.beds) items.push(`${facts.beds} bed`);
    if (facts?.baths) items.push(`${facts.baths} bath`);
    if (facts?.sqft) items.push(`${facts.sqft.toLocaleString()} sqft`);
    if (facts?.yearBuilt) items.push(`built ${facts.yearBuilt}`);
    if (footprint) items.push(`real outline, ${Math.round(footprint.areaSqft)} sqft ground floor`);
    if (exterior?.storeys) items.push(`${exterior.storeys} storeys, from the map`);
    if (exterior?.roof?.shape) items.push(`${exterior.roof.shape} roof`);
    if (exterior?.walls?.material) items.push(exterior.walls.material);
    if (photos.length > 0) items.push(`${photos.length} photos`);
    return items;
  }, [facts, footprint, exterior, photos.length]);

  /**
   * Enough to build something.
   *
   * Any one of these is enough on its own: photographs, the building's outline,
   * the listing's facts, or a typed description. Requiring photographs was the
   * old rule and it is what forced an upload before anything could happen.
   */
  const canBuild =
    photos.length > 0 ||
    footprint !== null ||
    Boolean(facts?.sqft || facts?.beds) ||
    description.trim().length > 0;

  useEffect(() => {
    if (restoring || resumable || photos.length === 0) return;
    const timer = setTimeout(() => {
      void saveDraft({
        propertyId,
        label,
        step: stage === "review" ? "arrange" : "photos",
        plan,
        description,
        photos: photos.map((p) => ({
          id: p.id,
          name: p.name,
          ref: p.ref,
          roomLabel: p.roomLabel,
        })),
        updatedAt: Date.now(),
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [photos, stage, plan, label, description, propertyId, restoring, resumable]);

  const resume = async (draft: Draft) => {
    const urls = await resolveDraftUrls(draft);
    setPropertyId(draft.propertyId);
    setLabel(draft.label);
    setPlan(draft.plan);
    if (draft.description) {
      setDescription(draft.description);
      setSpec(describeToSpec(draft.description));
    }
    setPhotos(
      draft.photos.map((photo) => ({
        id: photo.id,
        name: photo.name,
        file: null,
        ref: photo.ref,
        url: urls.get(photo.id) ?? "",
        roomLabel: photo.roomLabel,
      })),
    );
    setResumable(null);
  };

  /**
   * Everything between "here are my photos" and "here is your house".
   *
   * Ordering is not arbitrary. Rooms have to be identified before the house can
   * be laid out; the layout has to exist before a camera can be placed in it;
   * and poses have to be settled before depth, because the far anchor that
   * turns relative depth into metres depends on which way the camera faces.
   */
  const build = useCallback(async () => {
    setStage("building");
    const gathered: string[] = [];

    // --- 1. What room is each photo? ---
    const read = await labelPhotos(photos, roomHints(spec), setStep);
    const labelled = read.photos;
    if (read.labelled > 0) setPhotos(labelled);
    if (read.adjacency.length > 0) {
      adjacencyRef.current = read.adjacency;
      gathered.push(
        `Spotted ${read.adjacency.length} connection${read.adjacency.length === 1 ? "" : "s"} between rooms in the photos.`,
      );
    }

    const roomLabels: string[] = [];
    for (const photo of labelled) {
      if (photo.roomLabel && !roomLabels.includes(photo.roomLabel)) roomLabels.push(photo.roomLabel);
    }

    // --- 2. What shape is the house? ---
    setStep({ label: "Working out the layout", done: 0, total: 1 });
    const described = spec?.rooms ?? [];
    const describedLabels = new Set(described.map((r) => r.label));
    const extras = roomLabels
      .filter((l) => !describedLabels.has(l))
      .map((l) => ({ label: l, level: 0 }));
    const source = [...described, ...extras];
    let rooms = source.length > 0 ? source : roomLabels.map((l) => ({ label: l, level: 0 }));

    // An address with no photographs, no listing facts and no description still
    // has to produce a house. A plain three-bed is the most common home in the
    // country and is a far better starting point than an empty outline - the
    // shape is right, and the rooms inside it are the part the user can fix in
    // the builder in seconds.
    if (rooms.length === 0) {
      rooms = [
        "Living Room", "Kitchen", "Dining Room", "Primary Bedroom",
        "Bedroom 2", "Bedroom 3", "Bathroom", "Bathroom 2", "Hallway",
      ].map((label) => ({ label, level: 0 }));
      gathered.push("No room details were available, so this is a typical three-bedroom plan — correct it below.");
    }

    const adjacency = adjacencyRef.current;
    // Pack into the building's real outline when the address gave us one.
    // The shape of the house is the thing a viewer recognises, and it is the
    // one part of this that is measured rather than inferred - so it wins over
    // the invented rectangle whenever it exists.
    // Trust the count derived from the two areas over the number of levels the
    // room list happens to use - a description that never mentioned an upstairs
    // would otherwise squash a two-storey house onto one floor.
    const storeys = Math.max(
      footprint?.storeys ?? 1,
      new Set(rooms.map((r) => r.level)).size,
    );
    const built = footprint
      ? layoutFromFootprint(
          { rooms },
          prepareFootprint(
            footprint.ring,
            // The outline is the ground floor, so the listing's total area has
            // to be divided by the storeys standing on it.
            facts?.sqft ? facts.sqft / storeys : undefined,
            Math.max(1, rooms.filter((r) => r.level === 0).length),
          ),
          adjacency,
        )
      : layoutFromSpec(
          { rooms },
          facts?.sqft ? sqftToM2(facts.sqft) : undefined,
          adjacency,
        );
    const nextPlan: Plan = {
      scaleRef: { px: 1, meters: M_PER_FT },
      rooms: built.rooms,
      openings: built.openings,
    };
    setPlan(nextPlan);
    gathered.push(
      `${built.rooms.length} rooms, ${built.openings.length} doorways.`,
    );
    if (footprint) {
      // Worth saying out loud. It is the one measurement in the whole build,
      // and it is also an attribution the ODbL requires wherever it is shown.
      gathered.push(
        `Shaped to the real building outline from the map (${Math.round(footprint.areaSqft)} sqft ground floor). ${footprint.attribution}.`,
      );
    }

    // --- 2b. What does the house look like from outside? ---
    //
    // After the layout because the outline is what makes the reading useful:
    // the model is asked to annotate a shape it is given rather than to work
    // one out. Skipped entirely without a site, and failing quietly - a house
    // down a private track has no street view, and that is not an error.
    let outside = exterior;
    if (listingSite) {
      setStep({ label: "Looking at the outside", done: 0, total: 1 });
      const read = await readExterior({
        lat: listingSite.lat,
        lon: listingSite.lon,
        outline: footprint?.outline ?? [],
        storeys: exterior?.storeys ?? null,
      });
      outside = mergeExterior(exterior, read);
      if (read) {
        const said = [
          read.storeys ? `${read.storeys} storeys` : null,
          read.roof?.shape ? `a ${read.roof.shape} roof` : null,
          read.walls?.material ?? null,
        ].filter(Boolean);
        if (said.length > 0) {
          gathered.push(`Looked at the house from the street and the air: ${said.join(", ")}.`);
        }
      }
    }

    // --- 3. Put the photos in the rooms ---
    const placed = placePhotos(nextPlan, labelled);

    let assembled: Property = {
      id: propertyId,
      label: label || "My home",
      displayUnits: "ft",
      plan: nextPlan,
      nodes: placed.nodes,
      splats: [],
      // Filled in once someone grades the property; the BOM treats an empty
      // map as 'nothing seen yet' rather than 'nothing needed'.
      condition: {},
      houseCondition: {},
      rates: {},
      // Where the house is, so the daylight can be its own rather than a
      // studio light. The bearing follows from the rotation the footprint
      // needed to square it up: the outline is projected with +x east, so
      // turning it by that angle puts plan +x that many degrees round from
      // east.
      site:
        listingSite && footprint
          ? { ...listingSite, planXBearing: 90 + footprint.rotationDeg }
          : listingSite
            ? { ...listingSite, planXBearing: 90 }
            : null,
      // Survey data about the outside. Optional everywhere it is read, so a
      // house with none behaves exactly as it always has.
      exterior: outside,
    };
    if (placed.unplaced > 0) {
      gathered.push(
        `${placed.unplaced} photo${placed.unplaced === 1 ? "" : "s"} had no matching room and ${placed.unplaced === 1 ? "was" : "were"} left out.`,
      );
    }
    saveProperty(assembled);

    // --- 4. Where was each photo taken from? ---
    const posed = await posePhotos(nextPlan, assembled.nodes, setStep);
    assembled = { ...assembled, nodes: posed.nodes };
    saveProperty(assembled);
    if (posed.refined > 0) {
      gathered.push(
        `Aimed ${posed.refined} camera${posed.refined === 1 ? "" : "s"} from what the photo${posed.refined === 1 ? " shows" : "s show"}.`,
      );
    }

    setProperty(assembled);
    setNotes(gathered);
    setStep(null);
    setStage("review");
    await clearDraft(false);

    // --- 5. Depth, in the background, while they look around ---
    const estimator = new DepthEstimator();
    estimatorRef.current = estimator;
    await estimateDepth(estimator, assembled, setDepth, (updated) => {
      saveProperty(updated);
      setProperty(updated);
    });
  }, [photos, spec, facts, footprint, listingSite, exterior, propertyId, label]);

  if (restoring) {
    return (
      <main className="grid min-h-screen place-items-center text-sm text-mist-400">
        Checking for saved work…
      </main>
    );
  }

  if (resumable) {
    const done = resumable.photos.filter((p) => p.roomLabel).length;
    return (
      <main className="grid min-h-screen place-items-center px-6">
        <div className="w-full max-w-md rounded-xl border border-ink-600 bg-ink-800 p-6 text-center">
          <div className="text-4xl">📦</div>
          <h1 className="mt-3 text-lg font-medium">You have a tour in progress</h1>
          <p className="mt-2 text-sm leading-relaxed text-mist-400">
            {resumable.photos.length} photo{resumable.photos.length === 1 ? "" : "s"}
            {done > 0 && `, ${done} already placed`}. Saved{" "}
            {new Date(resumable.updatedAt).toLocaleString()}.
          </p>
          <div className="mt-5 flex gap-2">
            <button
              onClick={() => void resume(resumable)}
              className="flex-1 rounded bg-accent px-4 py-2.5 text-sm font-medium text-ink-900"
            >
              Pick up where I left off
            </button>
            <button
              onClick={() => void clearDraft(true).then(() => setResumable(null))}
              className="rounded border border-ink-500 px-4 py-2.5 text-sm"
            >
              Start over
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen px-6 py-10">
      <div className="mx-auto max-w-5xl">
        {stage === "photos" && (
          <>
            <div className="mx-auto mb-6 max-w-3xl text-center">
              <h1 className="text-2xl font-semibold tracking-tight">Make a house</h1>
              <p className="mt-2 text-sm leading-relaxed text-mist-400">
                Give it an address or a listing link and it will find the photos, the room
                counts and the building&rsquo;s real outline, then build the house from them.
                Photos of your own are optional.
              </p>
            </div>

            <PropertyStart onImported={importListing} />

            {/* What the address actually turned up, before anything is built.
                Saying so here is what makes the next click feel safe. */}
            {found.length > 0 && (
              <div className="mx-auto mt-5 max-w-2xl rounded-lg border border-ink-600 bg-ink-800 px-4 py-3">
                <div className="text-xs font-medium text-mist-200">
                  {label || "Found this property"}
                </div>
                <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mist-400">
                  {found.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Photos are a way in of their own, and after a lookup they are the
                way to fill the house in. Folded away until wanted either way. */}
            <details
              className="mx-auto mt-5 max-w-2xl rounded-lg border border-ink-600 bg-ink-800"
              open={photos.length > 0}
            >
              <summary className="cursor-pointer px-4 py-3 text-sm text-mist-200">
                {photos.length > 0
                  ? `${photos.length} photo${photos.length === 1 ? "" : "s"}`
                  : "Add photos"}{" "}
                <span className="text-mist-400">
                  &mdash; {canBuild
                    ? "optional; they add the 3D walk-through and let it read the condition"
                    : "or start from photos alone, with no address at all"}
                </span>
              </summary>
              <div className="border-t border-ink-600 p-4">
                <PhotoDrop
                  photos={photos}
                  onAdd={addPhotos}
                  onRemove={(id) => {
                    const photo = photos.find((p) => p.id === id);
                    setPhotos((c) => c.filter((p) => p.id !== id));
                    if (photo) void deleteMedia(refToKey(photo.ref));
                  }}
                />
              </div>
            </details>

            {canBuild && (
              <>
                <details className="mx-auto mt-4 max-w-2xl rounded-lg border border-ink-600 bg-ink-800">
                  <summary className="cursor-pointer px-4 py-3 text-sm text-mist-200">
                    Describe the house{" "}
                    <span className="text-mist-400">
                      &mdash;{" "}
                      {facts?.beds
                        ? "read from the listing; correct it if it is wrong"
                        : "optional, but it is how it knows the bedroom count"}
                    </span>
                  </summary>
                  <div className="border-t border-ink-600 p-4">
                    <DescribeHouse
                      text={description}
                      spec={spec}
                      onChange={(next, nextSpec) => {
                        setDescription(next);
                        setSpec(nextSpec);
                      }}
                    />
                  </div>
                </details>

                <div className="mx-auto mt-6 flex max-w-2xl justify-center">
                  <button
                    onClick={() => void build()}
                    className="rounded-lg bg-accent px-8 py-3 text-sm font-semibold text-ink-900 transition hover:brightness-110"
                  >
                    {photos.length > 0 ? "Build my tour" : "Build the house"}
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {stage === "building" && (
          <div className="mx-auto max-w-md py-20 text-center">
            <div className="text-5xl">🏗️</div>
            <h2 className="mt-4 text-lg font-medium">Building your house</h2>
            <p className="mt-2 text-sm text-mist-400">
              {step?.label ?? "Getting started"}
              {step && step.total > 1 && ` · ${step.done}/${step.total}`}
            </p>
            <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-ink-600">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${step && step.total > 0 ? (step.done / step.total) * 100 : 8}%` }}
              />
            </div>
            <p className="mt-4 text-[11px] leading-relaxed text-mist-400">
              Reading the rooms, working out how they fit together, and aiming each camera.
              Usually under a minute.
            </p>
          </div>
        )}

        {stage === "review" && plan && property && (
          <>
            <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold tracking-tight">Here is your house</h1>
                <p className="mt-1 text-sm text-mist-400">
                  {notes.join(" ")} Change anything that looks wrong &ndash; or just open it.
                </p>
              </div>
              <a
                href={`/tour/${propertyId}`}
                className="rounded-lg bg-accent px-6 py-2.5 text-sm font-semibold text-ink-900"
              >
                Walk through it
              </a>
            </div>

            {depth.stage !== "done" && depth.total > 0 && (
              <div className="mb-4 rounded-lg border border-ink-600 bg-ink-800 px-4 py-2.5">
                <div className="flex items-center justify-between text-xs text-mist-400">
                  <span>
                    {depth.stage === "loading-model" && depth.modelPercent !== undefined
                      ? `Downloading the 3D model… ${depth.modelPercent}%`
                      : `Adding depth to each room · ${depth.completed}/${depth.total}`}
                  </span>
                  <span>You can open the tour now; rooms turn 3D as it goes</span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-600">
                  <div
                    className="h-full bg-accent transition-all"
                    style={{
                      width: `${
                        depth.stage === "loading-model" && depth.modelPercent !== undefined
                          ? depth.modelPercent
                          : (depth.completed / Math.max(depth.total, 1)) * 100
                      }%`,
                    }}
                  />
                </div>
              </div>
            )}

            <PlanBuilder
              plan={plan}
              photoCounts={photos.reduce<Record<string, number>>((acc, p) => {
                if (p.roomLabel) acc[p.roomLabel] = (acc[p.roomLabel] ?? 0) + 1;
                return acc;
              }, {})}
              displayUnits="ft"
              livingAreaSqft={facts?.sqft ?? undefined}
              onChange={(next) => {
                setPlan(next);
                // Re-place rather than carrying nodes over: a redrawn plan has
                // different room ids, and stale ones orphan the photos.
                const existingDepth = new Map(property.nodes.map((n) => [n.id, n.depth]));
                const { nodes } = placePhotos(next, photos);
                const updated = {
                  ...property,
                  plan: next,
                  // Depth already computed is keyed to the photo, not the room,
                  // so it survives a re-layout and need not be recomputed.
                  nodes: nodes.map((n) => ({ ...n, depth: existingDepth.get(n.id) ?? null })),
                };
                setProperty(updated);
                saveProperty(updated);
              }}
            />

            <div className="mt-6">
              <PhotoReview
                photos={photos}
                spec={spec}
                onTag={(photoId, roomLabel) =>
                  setPhotos((c) =>
                    c.map((p) => (p.id === photoId ? { ...p, roomLabel, guessed: undefined } : p)),
                  )
                }
              />
            </div>

            <div className="mt-6 flex items-center justify-between border-t border-ink-600 pt-4">
              <a
                href={`/editor?id=${propertyId}`}
                className="text-xs text-mist-400 underline underline-offset-4 hover:text-mist-200"
              >
                Fine-tune in the editor
              </a>
              <button
                onClick={() => void build()}
                className="rounded border border-ink-500 px-4 py-2 text-xs hover:bg-ink-600"
              >
                Rebuild from the photos
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
