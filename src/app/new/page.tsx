"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { DescribeHouse } from "@/components/wizard/DescribeHouse";
import { DriveImport } from "@/components/wizard/DriveImport";
import { PhotoDrop, type ImportedPhoto } from "@/components/wizard/PhotoDrop";
import { PropertyStart } from "@/components/wizard/PropertyStart";
import { PhotoReview } from "@/components/wizard/PhotoReview";
import { PlanBuilder } from "@/components/wizard/PlanBuilder";
import { type BuildEvidence, gatherEvidence } from "@/lib/build/gather";
import {
  type BuildStep,
  placePhotos,
  posePhotos,
} from "@/lib/build/pipeline";
import {
  factsToDescription,
  type ListingFacts,
  type ListingFootprint,
  type ListingResult,
} from "@/lib/listing/types";
import { deleteMedia, mediaKeys, mediaRef, refToKey, resolveMediaUrl } from "@/lib/media-store";
import { layoutFromSpec } from "@/lib/plan/autolayout";
import { type PackPlan, layoutFromFootprint } from "@/lib/plan/footprint";
import { arrangeRooms } from "@/lib/plan/layout-client";
import { roomKind } from "@/lib/plan/room-kind";
import { type HouseSpec, describeToSpec } from "@/lib/plan/describe";
import { buildBom } from "@/lib/bom/build";
import { type GradeProgress, gradeProperty } from "@/lib/bom/grade-client";
import { canSync, rememberAdminKey, syncBlocker, syncProperty } from "@/lib/cloud/sync";
import { loadProperty, saveProperty } from "@/lib/property-store";
import { inferHouse } from "@/lib/spec/infer";
import { type ReadProgress, readRooms } from "@/lib/spec/read-client";
// Aliased: `HouseSpec` is already taken here by the room-list type that
// `describe` produces, which is a different thing entirely.
import { HouseSpec as RoomSpecDoc } from "@/lib/spec/schema";
import type { Exterior, Plan, Property } from "@/lib/schema";
import { requestPersistence } from "@/lib/storage/db";
import {
  type Intake,
  clearIntake,
  loadIntake,
  resolveIntakeUrls,
  saveIntake,
  storeIntakePhoto,
} from "@/lib/storage/intake";
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

/**
 * A readable id that cannot collide.
 *
 * The date is kept because it sorts sensibly and stays legible in a URL, but it
 * used to be the whole id at minute resolution - so two tours started in the
 * same minute shared a document, a photo prefix, and each other's fate. The
 * suffix is what makes it an identifier rather than a timestamp.
 */
function newPropertyId(): string {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const clock = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const unique = Math.random().toString(36).slice(2, 7);
  return `home-${day}-${clock}-${unique}`;
}

/**
 * Photographs already in storage for a tour, when the import record is gone.
 *
 * The record is an optimisation, not the only proof a photograph exists - the
 * blobs are the truth, and they are keyed by the property they belong to. This
 * is what makes a crash between writing a picture and writing the record
 * recoverable rather than a silent loss.
 */
async function photosFromStorage(propertyId: string): Promise<ImportedPhoto[]> {
  const keys = await mediaKeys();
  const mine = keys
    .filter((key) => key.startsWith(`${propertyId}/`) && key.endsWith("/photo"))
    .sort();

  const found: ImportedPhoto[] = [];
  for (const key of mine) {
    const url = await resolveMediaUrl(mediaRef(key));
    if (!url) continue;
    const id = key.slice(propertyId.length + 1, -"/photo".length);
    found.push({ id, name: id, file: null, ref: mediaRef(key), url, roomLabel: null });
  }
  return found;
}

function NewTourInner() {
  const params = useSearchParams();
  const resumeId = params.get("id");

  const [stage, setStage] = useState<Stage>("photos");
  const [photos, setPhotos] = useState<ImportedPhoto[]>([]);
  const [propertyId] = useState(() => resumeId ?? newPropertyId());
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
  /** How far the condition scan has got, or null when it is not running. */
  const [scan, setScan] = useState<GradeProgress | null>(null);
  /** How far the interior read has got, or null when it is not running. */
  const [reading, setReading] = useState<ReadProgress | null>(null);
  const [scanned, setScanned] = useState(0);
  /** How the copy on the server is doing: uploading, done, or refused. */
  const [sync, setSync] = useState<
    | { state: "off" }
    | { state: "needs-key" }
    | { state: "uploading"; done: number; total: number }
    | { state: "done"; slug: string }
    | { state: "failed"; why: string }
  >({ state: "off" });
  /** What the scope comes to as the scan fills it in. */
  const scopeTotal = useMemo(
    () =>
      property
        ? buildBom(property.plan, property.condition, property.rates, property.houseCondition)
            .total
        : 0,
    [property],
  );

  /**
   * True until a resumed import has been read back.
   *
   * Kept even though the resume *prompt* is gone. `/new?id=x` mounts with no
   * photos and fills them in asynchronously, so an ungated persist effect would
   * fire at 400ms and write an empty import over the one it is in the middle of
   * restoring - the same shape of bug as the missing stage guard that started
   * all of this.
   */
  const [restoring, setRestoring] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

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

  useEffect(() => {
    void requestPersistence();
  }, []);

  /**
   * Pick up a named import, or start clean.
   *
   * With no id there is nothing to read, so the common case - "make a house" -
   * never touches IndexedDB before the first photograph. That also means it can
   * no longer hang on the database being blocked by another tab, which is what
   * "Checking for saved work…" used to do forever.
   */
  useEffect(() => {
    if (!resumeId) {
      setRestoring(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const [intake, saved] = await Promise.all([
          loadIntake(resumeId),
          Promise.resolve(loadProperty(resumeId)),
        ]);
        if (cancelled) return;

        if (saved?.label) setLabel(saved.label);
        if (intake) {
          const urls = await resolveIntakeUrls(intake);
          if (cancelled) return;
          if (intake.label) setLabel(intake.label);
          if (intake.description) {
            setDescription(intake.description);
            setSpec(describeToSpec(intake.description));
          }
          if (intake.facts) setFacts(intake.facts);
          if (intake.footprint) setFootprint(intake.footprint);
          if (intake.site) setListingSite(intake.site);
          setPhotos(
            intake.photos.map((photo) => ({
              id: photo.id,
              name: photo.name,
              file: null,
              ref: photo.ref,
              url: urls.get(photo.id) ?? "",
              roomLabel: photo.roomLabel,
              guessed: photo.guessed,
            })),
          );
        } else {
          // No import record, but the photographs may still be there - a crash
          // between writing a blob and writing the record leaves exactly that.
          // The names and the room labels are gone; the pictures are not, and
          // they are the expensive half.
          const recovered = await photosFromStorage(resumeId);
          if (!cancelled && recovered.length > 0) setPhotos(recovered);
        }
      } catch {
        // A refusal from IndexedDB must not strand the page on a spinner.
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [resumeId]);

  const addPhotos = useCallback(
    async (files: File[]) => {
      const added: ImportedPhoto[] = [];
      for (let i = 0; i < files.length; i++) {
        // `Date.now()` alone collides for two batches dropped in the same
        // millisecond, and `putMedia` is an upsert - so the collision silently
        // overwrote a photograph rather than erroring.
        const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${i}`;
        const record = await storeIntakePhoto(propertyId, id, files[i]);
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
   * the listing's facts, a typed description - or simply knowing where the
   * house is. Requiring photographs was the old rule and it is what forced an
   * upload before anything could happen.
   *
   * Knowing where it is belongs on that list and was missing, which only showed
   * once an address stopped scraping by default. Before, a lookup nearly always
   * came back with beds and baths and those carried it; now an address does the
   * map half alone, so a building OpenStreetMap has never drawn left a located
   * property with no way to build it - a field that appeared to have done
   * nothing. `build` already handles exactly this, falling back to a typical
   * three-bed on the right site, and only needed permission to be reached.
   */
  const canBuild =
    photos.length > 0 ||
    footprint !== null ||
    listingSite !== null ||
    Boolean(facts?.sqft || facts?.beds) ||
    description.trim().length > 0;

  /**
   * Anything worth keeping is worth saving now.
   *
   * The tour becomes a real, listed property the moment there is something in
   * it, rather than at step three of a build that may never finish. Before
   * this, an interruption anywhere earlier - a closed tab, a refresh, a throw -
   * persisted nothing at all, and the only record was a draft that the wizard
   * then went on to delete.
   *
   * The document and the import record are written separately and on purpose.
   * The document is the tour; the import record is the wizard's working state,
   * and it lives in IndexedDB beside the photographs it references so the two
   * cannot get out of step.
   */
  const anythingWorthKeeping =
    photos.length > 0 ||
    footprint !== null ||
    Boolean(facts?.sqft || facts?.beds) ||
    description.trim().length > 0 ||
    label.trim().length > 0;

  useEffect(() => {
    // Never write an untouched blank one. Bouncing off `/new` would otherwise
    // leave an empty tour on the home page every single time - the rule the
    // editor already states for the same reason.
    if (restoring || stage !== "photos" || !anythingWorthKeeping) return;

    const timer = setTimeout(() => {
      // The document first, so a crash leaves a tour that is merely empty
      // rather than photographs under a prefix nothing names.
      if (!loadProperty(propertyId)) {
        saveProperty({
          id: propertyId,
          label: label || "Untitled",
          displayUnits: "ft",
          plan: { scaleRef: { px: 1, meters: M_PER_FT }, rooms: [], openings: [] },
          nodes: [],
          splats: [],
          condition: {},
          houseCondition: {},
          rates: {},
        });
      } else if (label) {
        const stored = loadProperty(propertyId);
        if (stored && stored.label !== label) saveProperty({ ...stored, label });
      }

      void saveIntake({
        propertyId,
        label,
        description,
        facts,
        footprint,
        site: listingSite,
        photos: photos.map((p) => ({
          id: p.id,
          name: p.name,
          ref: p.ref,
          roomLabel: p.roomLabel,
          guessed: p.guessed,
        })),
        updatedAt: Date.now(),
      });
    }, 400);

    return () => clearTimeout(timer);
  }, [
    photos,
    stage,
    label,
    description,
    facts,
    footprint,
    listingSite,
    propertyId,
    restoring,
    anythingWorthKeeping,
  ]);

  /**
   * Everything between "here are my photos" and "here is your house".
   *
   * Ordering is not arbitrary. Rooms have to be identified before the house
   * can be laid out, and the layout has to exist before a photograph can be
   * attached to a room in it.
   */
  /**
   * Grade every room from its photographs, after the house is on screen.
   *
   * Saving room by room rather than at the end: this takes minutes on a large
   * house, and a closed tab used to throw all of it away. Each room re-reads
   * the stored document rather than a snapshot taken minutes ago, so anything
   * that landed in the meantime survives.
   */
  /**
   * Read what every photographed room is made of, then reason about the rest.
   *
   * Runs after the review screen is up, alongside the condition scan and in
   * the slot the depth pass used to occupy. Both write to the same document
   * and neither owns it, so each re-reads the stored copy before saving -
   * otherwise whichever finished last would quietly undo the other.
   *
   * Room by room, for the reason grading is: this takes minutes on a large
   * house, and the tour is already open in front of somebody while it runs.
   */
  const readInterior = useCallback(async (property: Property) => {
    setReading({ room: "", done: 0, total: property.plan.rooms.length });
    try {
      const result = await readRooms(
        property,
        property.spec ?? RoomSpecDoc.parse({}),
        (progress) => setReading(progress),
        (roomId, roomSpec) => {
          const stored = loadProperty(property.id);
          if (!stored) return;
          const spec = stored.spec ?? RoomSpecDoc.parse({});
          const next: Property = {
            ...stored,
            spec: { ...spec, rooms: { ...spec.rooms, [roomId]: roomSpec } },
          };
          saveProperty(next);
          setProperty(next);
        },
      );
      // The inference re-runs at the end of the read, so the final write is the
      // one that carries the conventions out to the rooms nobody photographed.
      const stored = loadProperty(property.id);
      if (stored) {
        const next: Property = { ...stored, spec: result.spec };
        saveProperty(next);
        setProperty(next);
      }
      setReading(null);
      if (result.notes.length > 0) {
        setNotes((current) => [...current, ...result.notes.slice(0, 4)]);
      }
    } catch {
      setReading(null);
    }
  }, []);

  const scanCondition = useCallback(async (property: Property) => {
    setScan({ room: "", done: 0, total: property.plan.rooms.length });
    try {
      const result = await gradeProperty(
        property,
        (progress) => setScan(progress),
        (roomId, grades) => {
          const stored = loadProperty(property.id);
          if (!stored) return;
          const next: Property = {
            ...stored,
            condition: { ...stored.condition, [roomId]: grades },
          };
          saveProperty(next);
          setProperty(next);
        },
      );
      setScan(null);
      setScanned(result.graded);
    } catch {
      setScan(null);
    }
  }, []);

  /**
   * Put the finished tour somewhere other than this browser.
   *
   * Deliberately the last thing and deliberately unable to fail the build: the
   * tour is already saved locally and complete before this runs, so a project
   * that is not configured, a passphrase nobody has entered, or a network that
   * drops halfway all leave exactly what existed before - a working local
   * tour - and say so rather than throwing it away.
   */
  const syncUp = useCallback(async (id: string) => {
    // A missing passphrase is worth saying out loud - it is one field away
    // from working, and staying silent is what would make "syncs automatically"
    // quietly untrue. A project that is not configured at all is not the
    // operator's problem, and says nothing.
    if (!canSync()) {
      setSync(syncBlocker() === "no-key" ? { state: "needs-key" } : { state: "off" });
      return;
    }
    const stored = loadProperty(id);
    if (!stored) return;

    setSync({ state: "uploading", done: 0, total: 0 });
    try {
      const result = await syncProperty(stored, (done, total) =>
        setSync({ state: "uploading", done, total }),
      );
      if (result.ok) {
        setSync({ state: "done", slug: result.slug });
        setProperty(loadProperty(id) ?? stored);
      } else {
        setSync({ state: "failed", why: result.error });
      }
    } catch (error) {
      setSync({
        state: "failed",
        why: error instanceof Error ? error.message : "upload failed",
      });
    }
  }, []);

  /**
   * Build the house from evidence, and from a layout if one was drawn.
   *
   * The second half of what used to be one function. It takes a finished
   * `BuildEvidence` rather than gathering its own, which is what makes it
   * possible to stop between the two and let somebody draw - you cannot pause
   * halfway through a function to ask a question.
   *
   * `drawn` is that question's answer. Null means nobody was asked, and the
   * arrangement is worked out the way it always has been: the packer's own
   * shelf packing, improved by a model that decides only which room goes where.
   * That is still the path every build takes today; the layout stage is the
   * thing that will start passing a plan in.
   */
  const construct = useCallback(
    async (evidence: BuildEvidence, drawn: Plan | null) => {
      const gathered = [...evidence.notes];
      const { footprint: prepared, adjacency, rooms } = evidence;
      const labelled = evidence.photos;
      const outside = evidence.outside;
      const houseCondition = evidence.houseCondition;

      /**
       * Where the rooms go, asked rather than shelf-packed.
       *
       * Skipped entirely when a layout was drawn - there is nothing to arrange
       * once somebody has said where the walls are, and asking anyway would be
       * spending a request to be overruled.
       */
      const plans = new Map<number, PackPlan>();
      if (!drawn && prepared) {
        setStep({ label: "Arranging the rooms", done: 0, total: 1 });
        const groundLabels = rooms
          .filter((r) => r.level === 0 && roomKind(r.label) !== "outside")
          .map((r) => r.label);
        const arranged = await arrangeRooms(prepared, groundLabels, adjacency, {
          frontDoorBearing: outside?.frontDoorBearing ?? null,
          garageBearing: outside?.garage?.bearing ?? null,
          planXBearing: 90 + prepared.rotationDeg,
        });
        if (arranged) {
          plans.set(0, arranged.plan);
          if (arranged.reasoning) gathered.push(arranged.reasoning);
        }
      }

      const nextPlan: Plan =
        drawn ??
        (() => {
          const built = prepared
            ? layoutFromFootprint({ rooms }, prepared, adjacency, plans)
            : layoutFromSpec(
                { rooms },
                facts?.sqft ? sqftToM2(facts.sqft) : undefined,
                adjacency,
              );
          return {
            scaleRef: { px: 1, meters: M_PER_FT },
            rooms: built.rooms,
            openings: built.openings,
          };
        })();
      setPlan(nextPlan);
      gathered.push(
        `${nextPlan.rooms.length} rooms, ${nextPlan.openings.length} doorways.`,
      );

      // --- 4. Put the photos in the rooms, and work out what they are made of ---
      const placed = placePhotos(nextPlan, labelled);

      /**
       * What every room is made of, reasoned rather than defaulted.
       *
       * Nothing has read a photograph for finishes yet, so at this point the
       * inference is working purely from the plan - which rooms these are, which
       * of them open into one another, and what a house of this shape usually
       * does. That is already worth a great deal: it is the difference between a
       * hallway floored to match the rooms it serves and a hallway floored from a
       * lookup table, and it means a house built from an address alone still
       * comes out looking like one house.
       *
       * Stored rather than derived at render time, because the point is that it
       * can be corrected. Every value carries where it came from, so a later
       * reading of the photographs - or a person disagreeing with it - overwrites
       * only what is still a guess.
       */
      const inference = inferHouse(nextPlan, RoomSpecDoc.parse({}));
      gathered.push(...inference.conventions);

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
        houseCondition,
        rates: {},
        // Where the house is, so the daylight can be its own rather than a
        // studio light. The bearing follows from the rotation the footprint
        // needed to square it up: the outline is projected with +x east, so
        // turning it by that angle puts plan +x that many degrees round from
        // east.
        site:
          listingSite && prepared
            ? { ...listingSite, planXBearing: 90 + prepared.rotationDeg }
            : listingSite
              ? { ...listingSite, planXBearing: 90 }
              : null,
        // Survey data about the outside. Optional everywhere it is read, so a
        // house with none behaves exactly as it always has.
        exterior: outside,
        spec: inference.spec,
      };
      if (placed.unplaced > 0) {
        gathered.push(
          `${placed.unplaced} photo${placed.unplaced === 1 ? "" : "s"} had no matching room and ${placed.unplaced === 1 ? "was" : "were"} left out.`,
        );
      }
      saveProperty(assembled);

      // --- 5. Where was each photo taken from? ---
      const posed = await posePhotos(nextPlan, assembled.nodes, setStep);
      assembled = { ...assembled, nodes: posed.nodes };
      saveProperty(assembled);
      if (posed.refined > 0) {
        gathered.push(
          `Worked out which wall ${posed.refined} photo${posed.refined === 1 ? "" : "s"} ${posed.refined === 1 ? "is" : "are"} looking at.`,
        );
      }

      setProperty(assembled);
      setNotes(gathered);
      setStep(null);
      setStage("review");
      // The import is finished with, but its photographs are not - they are the
      // tour's now, under the same keys. Only the working state goes.
      await clearIntake(propertyId);

      // --- 6. The condition scan, while they look around ---
      //
      // After the review screen is up: the house should appear as fast as it
      // always did, and grading does not change what it looks like. The scan is
      // what makes a new tour arrive with a price on it rather than $0 until
      // somebody finds the button.
      //
      // This slot used to be shared with the depth pass, which ran concurrently
      // and wrote to the same document. Nothing renders a depth map now, so the
      // interior read has it: what a room is made of and what condition it is in
      // are two questions about the same photographs, and both are worth waiting
      // for a house that is already on screen.
      const scanning = scanCondition(assembled);
      const readingInterior = readInterior(assembled);

      // --- 7. Off this machine ---
      //
      // Waits for the scan, because the point is to send up the finished tour
      // rather than a half-graded one. Re-read rather than reusing `assembled`,
      // which by now is several passes out of date.
      await Promise.all([scanning, readingInterior]);
      await syncUp(propertyId);
    },
    [facts, listingSite, propertyId, label, syncUp, scanCondition, readInterior],
  );

  const build = useCallback(async () => {
    setStage("building");
    setFailed(null);
    try {
      const { evidence, photos: labelled } = await gatherEvidence(
        {
          photos,
          spec,
          facts,
          footprint,
          site: listingSite,
          exterior,
        },
        setStep,
      );
      if (labelled.some((p) => p.roomLabel)) setPhotos(labelled);
      adjacencyRef.current = evidence.adjacency;
      await construct(evidence, null);
    } catch (error) {
      // Most of the pipeline already fails soft - a classify batch, a pose
      // batch and the exterior read all swallow their own errors. What is left
      // is mostly the media store refusing to open, and without this the page
      // sat on the building screen forever with nothing said and no way back.
      // The photographs are safe either way: they and the import record were
      // written before any of this started.
      setFailed(error instanceof Error ? error.message : "Something went wrong building the house.");
      setStep(null);
      setStage("photos");
    }
  }, [photos, spec, facts, footprint, listingSite, exterior, construct]);


  if (restoring) {
    return (
      <main className="grid min-h-screen place-items-center text-sm text-mist-400">
        Checking for saved work…
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
                The address gives the building&rsquo;s real outline, which way it faces and
                what the outside is made of. The photographs can come from anywhere &mdash;
                dropped in, a Drive folder someone sent you, or pulled from the listing.
              </p>
            </div>

            {failed && (
              <div className="mx-auto mb-5 max-w-2xl rounded-lg border border-warn/40 bg-ink-800 px-4 py-3 text-xs leading-relaxed text-mist-200">
                The build stopped: {failed}
                <span className="mt-1 block text-mist-400">
                  Your photographs are saved and the tour is on the home page. Try building
                  again &mdash; nothing has been lost.
                </span>
              </div>
            )}

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
                    ? "drop them, or paste a Drive folder link"
                    : "drop them, paste a Drive folder link, or start from photos alone"}
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
                {/* Photographs arrive as a Drive link far more often than as a
                    folder on the machine doing the building. Same destination:
                    `addPhotos` is what the file input calls too. */}
                <DriveImport onFiles={addPhotos} busy={stage !== "photos"} />
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
              Reading the rooms, working out how they fit together, and matching each photo to
              the wall it shows.
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

            {/* The scope, as it fills in.
                A freshly built tour used to be worth $0 until somebody found
                the scope page - and nothing on this screen linked to it, or
                mentioned money at all. */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink-600 bg-ink-800 px-4 py-3">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wide text-mist-400">
                  Scope of work
                </div>
                <div className="text-lg font-semibold tabular-nums text-mist-200">
                  {scopeTotal.toLocaleString("en-US", {
                    style: "currency",
                    currency: "USD",
                    maximumFractionDigits: 0,
                  })}
                </div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-mist-400">
                  {scan
                    ? `Reading the photos${scan.room ? ` · ${scan.room}` : ""} · ${scan.done}/${scan.total} rooms`
                    : scanned > 0
                      ? `Graded ${scanned} room${scanned === 1 ? "" : "s"} from the photos. Furnace, wiring and plumbing were not looked at — no photograph shows them.`
                      : "Nothing graded yet. Open the scope to grade it by hand."}
                </div>
              </div>
              <a
                href={`/bom/${propertyId}`}
                className="shrink-0 rounded border border-ink-500 px-4 py-2 text-xs text-mist-200 hover:bg-ink-600"
              >
                Scope &amp; costs
              </a>
            </div>

            {/* The copy on the server.
                Shown only once there is something to say: a tour that is not
                syncing is the local-first tour this always was, and does not
                need a row explaining an absence. The link is the whole of the
                access control, so it is offered plainly and never derived from
                the address. */}
            {sync.state !== "off" && (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink-600 bg-ink-800 px-4 py-2.5 text-xs">
                {sync.state === "needs-key" && (
                  <>
                    <span className="text-mist-400">
                      Saved on this computer only. Enter the publish passphrase
                      to keep tours on your site too &ndash; asked once per browser.
                    </span>
                    <form
                      className="flex shrink-0 items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const field = new FormData(e.currentTarget).get("key");
                        const key = typeof field === "string" ? field.trim() : "";
                        if (!key) return;
                        rememberAdminKey(key);
                        void syncUp(propertyId);
                      }}
                    >
                      <input
                        type="password"
                        name="key"
                        aria-label="Publish passphrase"
                        className="w-40 rounded border border-ink-600 bg-ink-700 px-2 py-1.5 text-mist-200 outline-none focus:border-accent-dim"
                      />
                      <button
                        type="submit"
                        className="rounded border border-ink-500 px-3 py-1.5 text-mist-200 hover:bg-ink-600"
                      >
                        Save
                      </button>
                    </form>
                  </>
                )}
                {sync.state === "uploading" && (
                  <span className="text-mist-400">
                    Saving to your site
                    {sync.total > 0 ? ` · ${sync.done}/${sync.total} files` : "…"}
                  </span>
                )}
                {sync.state === "done" && (
                  <>
                    <span className="text-mist-400">
                      Saved to your site. Anyone with this link can open it.
                    </span>
                    <a
                      href={`/t/${sync.slug}`}
                      className="shrink-0 rounded border border-ink-500 px-4 py-2 text-mist-200 hover:bg-ink-600"
                    >
                      Shareable link
                    </a>
                  </>
                )}
                {sync.state === "failed" && (
                  <>
                    <span className="text-mist-400">
                      Saved on this computer, but not to your site &mdash; {sync.why}.
                    </span>
                    <button
                      type="button"
                      onClick={() => void syncUp(propertyId)}
                      className="shrink-0 rounded border border-ink-500 px-4 py-2 text-mist-200 hover:bg-ink-600"
                    >
                      Try again
                    </button>
                  </>
                )}
              </div>
            )}

            {reading && (
              <div className="mb-4 rounded-lg border border-ink-600 bg-ink-800 px-4 py-2.5">
                <div className="flex items-center justify-between text-xs text-mist-400">
                  <span>
                    Reading what each room is made of
                    {reading.room ? ` · ${reading.room}` : ""} · {reading.done}/
                    {reading.total}
                  </span>
                  <span>The tour is ready now; the detail fills in as it goes</span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-600">
                  <div
                    className="h-full bg-accent transition-all"
                    style={{ width: `${(reading.done / Math.max(reading.total, 1)) * 100}%` }}
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
                const { nodes } = placePhotos(next, photos);
                const updated = { ...property, plan: next, nodes };
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

/**
 * `useSearchParams` needs a boundary, and the fallback is what a fresh start
 * looks like for the instant before the params resolve. The editor already
 * splits this way for the same reason.
 */
export default function NewTourPage() {
  return (
    <Suspense
      fallback={
        <main className="grid min-h-screen place-items-center text-sm text-mist-400">
          Getting ready…
        </main>
      }
    >
      <NewTourInner />
    </Suspense>
  );
}
