"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { CameraRig, type ViewState, defaultViewFor } from "@/components/tour/CameraRig";
import { Lighting } from "@/components/tour/Lighting";
import { Measure, type MeasurePoints } from "@/components/tour/Measure";
import { ScriptedTour, recordCanvas, supportedFormat } from "@/components/tour/ScriptedTour";
import { type Beat, buildTour, tourDuration } from "@/lib/model/tour-script";
import {
  DEFAULT_SCHEME,
  THIS_HOUSE,
  type Scheme,
  schemeByName,
  schemesFor,
} from "@/lib/model/schemes";
import { dayOfYear, solarPosition } from "@/lib/model/sun";
import { WalkControls, type WalkState } from "@/components/tour/WalkControls";
import { roomAt } from "@/lib/model/collide";
import { ArchitecturalPlan } from "@/components/plan2d/ArchitecturalPlan";
import { ScopeRail } from "@/components/bom/ScopeRail";
import { Model } from "@/components/tour/Model";
import { applySpec } from "@/lib/spec/apply";
import { captureFromPose, type CapturePose } from "@/lib/render/capture";
import { inferHouse } from "@/lib/spec/infer";
import { HouseSpec } from "@/lib/spec/schema";
import { Post } from "@/components/tour/Post";
import { MAX_DPR, QUALITY_LABEL, TIERS, type Quality, detectQuality, rendererName } from "@/lib/render/quality";
import { isBundledUrl } from "@/lib/model/assets";
import { enableAssets, pendingAssets } from "@/lib/model/asset-surfaces";
import { buildBom } from "@/lib/bom/build";
import type { Element, Grade } from "@/lib/bom/condition";
import type { Pick } from "@/lib/bom/pickable";
import { loadProperty, saveProperty } from "@/lib/property-store";
import { RoomMarkers } from "@/components/tour/RoomMarkers";
import { Minimap } from "@/components/tour/Minimap";
import { PublishPanel } from "@/components/tour/PublishPanel";
import { Evidence } from "@/components/tour/Evidence";
import { ExteriorSpecPanel, RoomSpecPanel } from "@/components/tour/RoomSpecPanel";
import { walkStartFor } from "@/lib/model/focus";
import { levelName, levelsOf, boundsOf } from "@/lib/plan/geometry";
import type { Plan, Property } from "@/lib/schema";
import { SiteModel } from "@/components/tour/SiteModel";
import { siteInPlan } from "@/lib/site/plan-site";
import { exteriorLook } from "@/lib/model/exterior-look";
import { deriveLot, houseBounds } from "@/lib/site/lot";
import { windowsForLevel } from "@/lib/model/windows";

/**
 * What is actually on screen, for the browser suite.
 *
 * The scene is built entirely on the client, so nothing outside the canvas can
 * see it - which is why `window.__walk` and `window.__camera` already exist.
 * This one exists for a specific promise: no photograph is ever drawn in the
 * model. That is the whole direction of the project and it is exactly the kind
 * of thing that comes back by accident, so it is asserted mechanically rather
 * than by looking at a screenshot.
 *
 * `photoTextures` counts materials carrying a texture whose image came from a
 * blob or an http URL - a photograph. The procedural canvas textures are
 * generated in-page and have no `src`, so they do not count.
 */
function SceneReadout({ mode, furnished }: { mode: ViewState["mode"]; furnished: boolean }) {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const wrote = useRef(0);
  const projected = useRef(new THREE.Vector3());

  useFrame(() => {
    // Once a second is plenty: this walks the whole graph.
    const now = performance.now();
    if (now - wrote.current < 1000) return;
    wrote.current = now;

    let meshes = 0;
    let markers = 0;
    let stairMarkers = 0;
    let photoTextures = 0;
    let bundledTextures = 0;
    let triangles = 0;
    const markerAt: Array<[number, number]> = [];
    const bySurface: Record<string, number> = {};
    let emissive = 0;
    // Every distinct colour map in use. Two rooms in two wall materials have
    // two; a house whose every wall is plaster has one - which is how a suite
    // can tell that `walls.material` reached a mesh without reading pixels.
    const maps = new Set<unknown>();
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      meshes++;
      const geometry = mesh.geometry;
      if (geometry?.type === "RingGeometry") markers++;
      if (mesh.userData?.stairs) stairMarkers++;
      // Counted off the geometry rather than read from `gl.info.render`.
      // The effect composer runs several full-screen passes after the scene
      // and the renderer's counters are reset between them, so by the time a
      // frame callback can read them they describe the last blit and say
      // "1 call, 1 triangle" however large the house is.
      // What each element contributes, which is the only way to tell "the
      // ceiling is missing" from "the ceiling is there and dark".
      const element = (mesh.userData as { element?: string }).element;
      if (element) bySurface[element] = (bySurface[element] ?? 0) + 1;
      // Surfaces lit from within, which should only ever be a fitting somebody
      // has clicked. It is worth counting because the failure is invisible in
      // the place it matters: `emissive` is added after all lighting, so on a
      // bright wall it is a faint tint and on a ceiling - the dimmest surface
      // in any room - it is most of what you see. A whole room being picked
      // once made every ceiling in the house blue, and it survived turning off
      // every light in the scene while I looked for the cause.
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (material?.emissiveIntensity > 0 && material.emissive?.getHex?.() !== 0) emissive++;

      if (geometry?.type === "RingGeometry") {
        // Where the marker is on screen, as a fraction of the canvas.
        //
        // The browser suite has to click these, and sweeping a grid of guesses
        // for a target half a metre across is how a test ends up flaky in a
        // way that says nothing about the code. Projecting the real position
        // makes the click exact, so a failure means the marker genuinely did
        // not respond.
        mesh.getWorldPosition(projected.current);
        projected.current.project(camera);
        markerAt.push([
          (projected.current.x + 1) / 2,
          (1 - projected.current.y) / 2,
        ]);
      }

      const index = geometry?.getIndex();
      const position = geometry?.getAttribute("position");
      if (index) triangles += index.count / 3;
      else if (position) triangles += position.count / 3;

      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const standard = material as THREE.MeshStandardMaterial;
        if (standard?.map?.image) maps.add(standard.map.image);
        /**
         * The rule: no photograph of this house on the model.
         *
         * Every map slot is looked at, not only the colour map. A texture
         * is bundled when it says so or when its image came from this
         * origin under `/textures/` or `/sky/` - the sets the app ships.
         * Anything else with an image that is not a canvas the app drew is
         * a photograph, and counted: an `<img>` from anywhere else, a
         * bitmap, a compressed texture. The drawn surfaces are canvases and
         * count as nothing, as they always did.
         */
        for (const slot of ["map", "normalMap", "aoMap", "roughnessMap", "metalnessMap", "emissiveMap", "bumpMap"] as const) {
          const texture = standard?.[slot] as THREE.Texture | null | undefined;
          if (!texture?.image) continue;
          // The drawn surfaces' normal and ORM maps are data textures the
          // app computed from its own canvases: bytes, not a picture.
          if ((texture as THREE.DataTexture).isDataTexture) continue;
          const image = texture.image as { src?: string };
          const fromHere = typeof image.src === "string" && isBundledUrl(image.src, window.location.origin);
          if (texture.userData?.bundled || fromHere) bundledTextures++;
          else if (!(texture.image instanceof HTMLCanvasElement)) photoTextures++;
        }
      }
    });

    (window as unknown as { __scene?: unknown }).__scene = {
      // Which view these numbers describe. The readout is published once a
      // second, so anything reading it can otherwise be handed a count from
      // the view it just left - and a test that waits a fixed time for the
      // camera to change modes is a test that passes on a fast machine.
      mode,
      furnished,
      meshes,
      markers,
      stairMarkers,
      markerAt,
      bySurface,
      emissive,
      photoTextures,
      bundledTextures,
      // Scans asked for and not yet landed. A screenshot taken at zero is
      // the house dressed; one taken before is the house arriving.
      pending: pendingAssets(),
      distinctMaps: maps.size,
      triangles: Math.round(triangles),
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
    };
  });

  return null;
}

/**
 * A way to photograph the model from inside the canvas.
 *
 * Published on `window` rather than passed out through React, and that is not
 * laziness: the renderer and the scene only exist inside the canvas, while
 * everything that wants a capture - the verify pass, the browser suite - lives
 * outside it. It is the same arrangement `window.__walk`, `window.__camera` and
 * `window.__scene` already use, for the same reason.
 */
function CaptureRig() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    const w = window as unknown as { __capture?: (pose: CapturePose) => string | null };
    w.__capture = (pose) => captureFromPose(gl, scene, pose);
    return () => {
      delete w.__capture;
    };
  }, [gl, scene]);

  return null;
}

function Scene({
  property,
  view,
  onlyLevel,
  pick,
  onPick,
  dayOfYear,
  hour,
  explode,
  measuring,
  measurePoints,
  onMeasurePoint,
  scheme,
  tourBeats,
  touring,
  onTourBeat,
  onTourFinish,
  focusRoomId,
  onFocusRoom,
  onEnterRoom,
  onWalkRoom,
  walkStart,
  quality,
  furnished,
  showNeighbours,
  streetStart,
  tourBeatKind,
}: {
  property: Property;
  view: ViewState;
  streetStart: { kerb: [number, number] | null } | null;
  tourBeatKind: Beat["kind"] | null;
  onlyLevel: number | null;
  pick: Pick | null;
  onPick?: (pick: Pick) => void;
  dayOfYear: number;
  hour: number;
  explode: number;
  measuring: boolean;
  measurePoints: MeasurePoints;
  onMeasurePoint: (point: THREE.Vector3) => void;
  scheme: Scheme;
  tourBeats: ReturnType<typeof buildTour>;
  touring: boolean;
  onTourBeat: (beat: Beat | null) => void;
  onTourFinish: () => void;
  /** The room being looked at on its own, or null for the whole house. */
  focusRoomId: string | null;
  onFocusRoom: (roomId: string | null) => void;
  onEnterRoom: (roomId: string) => void;
  onWalkRoom: (roomId: string | null) => void;
  walkStart: { position: [number, number]; level: number; yaw: number } | null;
  quality: Quality;
  furnished: boolean;
  showNeighbours: boolean;
}) {
  // Which storey the walker is standing on, which changes under them on the
  // stairs rather than being chosen from the toolbar.
  const [walkLevel, setWalkLevel] = useState(0);
  // The surroundings in plan metres, or null for a house that has none.
  const planSite = useMemo(() => siteInPlan(property.site), [property.site]);
  // What the sun looks at and how far its shadows reach: the lot when there
  // is one, the house otherwise.
  const ground = useMemo(() => {
    const house = houseBounds(property.plan);
    if (!house) return null;
    const lot = planSite
      ? deriveLot({
          house,
          site: planSite,
          frontDoorBearing: property.exterior?.frontDoorBearing ?? null,
          garageBearing: property.exterior?.garage?.bearing ?? null,
          planXBearing: property.site?.planXBearing ?? 90,
        })
      : null;
    const box = lot ? boundsOf(lot.polygon) : house;
    // The wall facing the street, as the model names walls. The front door
    // is on it, so a fireplace keeps off it and its chimney with it.
    const front = lot ? ({ "-y": "north", "+y": "south", "-x": "west", "+x": "east" } as const)[lot.front.side] : null;
    return {
      centre: [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2] as [number, number],
      half: Math.max(box.x1 - box.x0, box.y1 - box.y0) / 2,
      front,
    };
  }, [property.plan, property.site, property.exterior, planSite]);
  const walkState = useRef<WalkState>({ x: 0, y: 0, level: 0, yaw: 0 });

  // The scans load only on a tier that can afford them, and this is where
  // the tier is known and the renderer can say how much anisotropy it has.
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    enableAssets(TIERS[quality].assets, gl.capabilities.getMaxAnisotropy());
  }, [quality, gl]);

  return (
    <>
      <Lighting
        site={property.site}
        dayOfYear={dayOfYear}
        hour={hour}
        interior={view.mode === "walk"}
        plan={property.plan}
        // Lit indoors, and after dark whatever the view. Nobody wants a
        // dollhouse glowing from inside at midday.
        lamps={view.mode === "walk" || hour < 7.5 || hour > 18.5}
        explode={explode}
        // The storey underfoot, which is the only one whose windows can reach
        // you. It changes on the stairs without being asked.
        levels={view.mode === "walk" ? [walkLevel] : null}
        quality={quality}
        // Air between the house and the edge of its ground, so the ground
        // ends in haze rather than a line. Indoors there is no horizon.
        fog={planSite !== null && view.mode !== "walk"}
        target={ground?.centre ?? null}
        shadowExtent={ground ? Math.max(26, ground.half + 6) : undefined}
      />

      <CameraRig
        plan={property.plan}
        view={view}
        paused={touring}
        explode={explode}
        focusRoomId={focusRoomId}
        streetStart={streetStart}
      />

      <Model
        frontWall={ground?.front ?? null}
        plan={property.plan}
        spec={property.spec}
        furnished={furnished}
        showLabels={view.mode === "dollhouse"}
        displayUnits={property.displayUnits}
        onlyLevel={view.mode === "walk" ? walkLevel : onlyLevel}
        // The dollhouse only. Standing inside the house - on foot, or being
        // flown through it by the scripted tour - there is nothing to compare
        // the room against, and ghosting the walls around you does not read as
        // focus. It reads as the building dissolving.
        focusRoomId={view.mode === "dollhouse" && !touring ? focusRoomId : null}
        pick={pick}
        onPick={onPick}
        onFocusRoom={onPick ? (roomId) => onFocusRoom(roomId) : undefined}
        onEnterRoom={onPick ? onEnterRoom : undefined}
        onMeasurePoint={measuring ? onMeasurePoint : undefined}
        walking={view.mode === "walk"}
        // From the street, or during the tour's shot from it, the facades
        // and the roof stay solid.
        street={view.mode === "street" || tourBeatKind === "street"}
        scheme={scheme}
        explode={explode}
        exterior={property.exterior}
        site={property.site}
      />

      <SiteModel
        plan={property.plan}
        site={property.site}
        planSite={planSite}
        exterior={property.exterior}
        spec={property.spec}
        scheme={scheme}
        showNeighbours={showNeighbours}
        labels={view.mode === "dollhouse" || view.mode === "street"}
      />

      <Measure points={measurePoints} displayUnits={property.displayUnits} />

      <ScriptedTour
        beats={tourBeats}
        running={touring}
        onBeat={onTourBeat}
        onFinish={onTourFinish}
      />

      <WalkControls
        plan={property.plan}
        level={walkLevel}
        onLevelChange={setWalkLevel}
        state={walkState}
        enabled={view.mode === "walk"}
        start={walkStart}
      />

      <WalkRoomDriver
        plan={property.plan}
        walkState={walkState}
        enabled={view.mode === "walk"}
        onRoomChange={onWalkRoom}
      />

      <SceneReadout mode={view.mode} furnished={furnished} />

      <CaptureRig />

      <Post quality={quality} eyeLevel={view.mode === "walk" || view.mode === "street"} />

      <RoomMarkers
        plan={property.plan}
        // Walking is how you get inside now, so the affordance is a place to
        // stand rather than a photograph to step into. Underfoot on the stairs
        // it is a way up; in the dollhouse it is a way in.
        mode={view.mode === "walk" ? "walk" : "dollhouse"}
        // Walking into a house in pieces means nothing, and from the street
        // the rings are behind solid walls.
        hidden={explode > 0 || view.mode === "street"}
        onlyLevel={onlyLevel}
        walkLevel={walkLevel}
        onEnterRoom={onEnterRoom}
      />
    </>
  );
}

/**
 * Which room the walker is standing in.
 *
 * "Walking into a room shows that room's scope" was the scope pane's founding
 * promise, and on foot it was never true: the effect that did it was gated on
 * having stepped into a *photograph*, so the first-person mode - the one where
 * you are most obviously in a particular room - was the one mode that never
 * told the rail anything. Walking is the only way inside now, which makes this
 * the only thing that reports it.
 *
 * Reported only when the room actually changes: this runs at 60Hz and crossing
 * a threshold is a rare event, so it must not cost a render on the frames where
 * nothing happens.
 */
function WalkRoomDriver({
  plan,
  walkState,
  enabled,
  onRoomChange,
}: {
  plan: Plan;
  walkState: React.MutableRefObject<WalkState>;
  enabled: boolean;
  onRoomChange: (roomId: string | null) => void;
}) {
  const last = useRef<string | null>(null);

  useFrame(() => {
    if (!enabled) return;
    const walk = walkState.current;
    const room = roomAt(plan, walk.level, walk.x, walk.y);
    const id = room?.id ?? null;
    if (id !== last.current) {
      last.current = id;
      onRoomChange(id);
    }
  });

  return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthOf(doy: number): number {
  const ends = [31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
  return ends.findIndex((end) => doy <= end);
}

function formatHour(hour: number): string {
  const h = Math.floor(hour) % 24;
  const m = Math.round((hour - Math.floor(hour)) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * One key of the walk pad. Presses and releases the same key the keyboard
 * would, through the window, so the walker needs no second set of inputs -
 * and a finger held on it keeps walking until it lifts.
 */
function WalkPad({ k, label, title }: { k: string; label: string; title: string }) {
  const press = (down: boolean) => window.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { key: k }));
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-walk-key={k}
      onPointerDown={(e) => {
        e.preventDefault();
        press(true);
      }}
      onPointerUp={() => press(false)}
      onPointerLeave={() => press(false)}
      onPointerCancel={() => press(false)}
      className="h-8 w-8 select-none rounded border border-ink-500 text-sm text-mist-200 transition hover:bg-ink-600 active:bg-ink-500"
    >
      {label}
    </button>
  );
}

export function TourViewer({
  property: raw,
  onPropertyChange,
}: {
  property: Property;
  onPropertyChange?: (property: Property) => void;
}) {
  /**
   * The house the spec describes, not the one the packer laid out.
   *
   * `applySpec` writes the two things that are geometry rather than finish -
   * how tall each room is, and how wide the openings between them are - into
   * the plan itself. Doing it here, once, means the walls, the walk graph, the
   * takeoff, the minimap and the 2D drawing all see the same building without
   * any of them having to learn what a spec is.
   */
  const property = useMemo(() => {
    /**
     * Every house gets a coherent set of finishes, whether or not anyone has
     * built one for it.
     *
     * A tour built before the spec existed - and every bundled sample - has
     * nothing stored, and the alternative is that its rooms fall back to a
     * per-room default table. That is exactly the incoherence the inference
     * exists to remove: a landing floored in generic oak between two rooms
     * floored in a specific walnut reads as a mistake rather than as a landing
     * nobody photographed.
     *
     * Inference is pure and deterministic, so deriving it here costs nothing
     * and needs no migration. A stored spec always wins - this only fills in
     * for a house that has none, and a house that is built today has one
     * written at build time so it can be corrected by hand.
     */
    const spec = raw.spec ?? inferHouse(raw.plan, HouseSpec.parse({})).spec;
    return { ...raw, spec, plan: applySpec(raw.plan, spec) };
  }, [raw]);
  // `?room=` deep-links a room, so a specific place in a house can be sent to
  // someone directly rather than "open the tour and walk to the kitchen". It
  // replaces `?node=`, which named a photograph - a thing the tour no longer
  // has - and it drops you on your feet inside the room rather than at a lens.
  /**
   * Where the street view and the tour's opening shot stand: the kerb
   * opposite the front door, and the door they look at.
   *
   * Above the view state, because the view a tour opens in is decided by it.
   */
  const streetStart = useMemo(() => {
    const planSite = siteInPlan(property.site);
    const house = houseBounds(property.plan);
    if (!house) return null;
    const lowest = Math.min(...property.plan.rooms.map((r) => r.level));
    const lot = deriveLot({
      house,
      site: planSite,
      frontDoorBearing: property.exterior?.frontDoorBearing ?? null,
      garageBearing: property.exterior?.garage?.bearing ?? null,
      planXBearing: property.site?.planXBearing ?? 90,
      windows: windowsForLevel(property.plan, lowest).map((w) => ({ center: w.center, width: w.width })),
    });
    return {
      kerb: lot.front.kerb ? ([lot.front.kerb[0], lot.front.kerb[1]] as [number, number]) : null,
      door: [lot.frontDoor[0], lot.frontDoor[1]] as [number, number],
      frontSide: lot.front.side,
    };
  }, [property.site, property.plan, property.exterior]);
  /** Where a tour opens, and where Exit goes: the kerb when the map placed one, else the dollhouse. */
  const defaultView = useMemo(() => defaultViewFor(streetStart), [streetStart]);
  const [view, setView] = useState<ViewState>(() => defaultView);

  // Storeys stack in the same plan coordinates, so an unfiltered dollhouse of a
  // two-floor house shows an upstairs bedroom sitting inside the kitchen. The
  // filter is navigation as much as decluttering.
  const levels = useMemo(() => levelsOf(property.plan), [property.plan]);
  const [onlyLevel, setOnlyLevel] = useState<number | null>(null);

  /**
   * What the scope pane is showing.
   *
   * Only meaningful for a locally-stored property: a published tour is someone
   * else's listing and has no business exposing its rehab costs to whoever
   * opens the link.
   */
  const [pick, setPick] = useState<Pick | null>(null);

  /**
   * The one room being looked at, or null for the whole house.
   *
   * Separate from `pick`, which is finer - a pick can be a single worktop - and
   * separate from `ViewState`, which is about how you are looking rather than
   * at what. Keeping it apart means stepping into a photograph inside the
   * focused room does not lose the focus, and no `mode ===` test anywhere has
   * to learn about it.
   */
  const [focusRoomId, setFocusRoomId] = useState<string | null>(null);
  /** Where a double click asked to be dropped in, consumed by WalkControls. */
  const [walkStart, setWalkStart] = useState<{
    position: [number, number];
    level: number;
    yaw: number;
  } | null>(null);

  // Whether the browser currently holds the mouse. The prompt has to go the
  // moment it does, or it sits in the middle of the room you are walking
  // through - and it has to come back on Esc, which the user can press at any
  // time without telling us.
  // Time of day, which only means anything when the house knows where it is.
  // A late-morning midsummer default rather than noon: the sun overhead casts
  // almost no shadow, which is the one time of day that makes a model look
  // flat.
  const [hour, setHour] = useState(10.5);
  const [dayOfYearValue, setDayOfYearValue] = useState(() => dayOfYear(6, 21));

  // The tape measure. Two clicks give a distance; a third starts again, which
  // is what people expect and saves a "clear" button being the only way out.
  const [measuring, setMeasuring] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<MeasurePoints>({ a: null, b: null });
  const addMeasurePoint = useCallback((point: THREE.Vector3) => {
    setMeasurePoints((current) =>
      current.a && !current.b ? { a: current.a, b: point } : { a: point, b: null },
    );
  }, []);

  // The interior direction. A single palette made every house this tool builds
  // look like the same house, which is strange for something whose claim is
  // that it builds yours.
  // A house that was looked at from the street offers its own colours first,
  // so the default is what the building actually is rather than a direction
  // somebody might take it in.
  // "This house" wears what the photographs saw, when they saw it, and what
  // the map saw otherwise - the same precedence the model draws with.
  const look = useMemo(() => exteriorLook(property.spec, property.exterior), [property.spec, property.exterior]);
  const schemes = useMemo(
    () => schemesFor({ walls: { colour: look.wallColour }, roof: { colour: look.roofColour } }),
    [look.wallColour, look.roofColour],
  );
  const [schemeName, setSchemeName] = useState<string | null>(null);
  // Its own colours when it has any, and otherwise the direction that was
  // always the default. A house nobody surveyed must look exactly as it did.
  const scheme = schemeByName(
    schemeName ?? (schemes[0].name === THIS_HOUSE ? THIS_HOUSE : DEFAULT_SCHEME.name),
    schemes,
  );

  // The scripted tour, and recording it.
  const [touring, setTouring] = useState(false);
  const [tourCaption, setTourCaption] = useState("");
  /** The kind of beat playing, so a shot from the street keeps the facades. */
  const [tourBeatKind, setTourBeatKind] = useState<Beat["kind"] | null>(null);
  const [recording, setRecording] = useState(false);
  const stopRecording = useRef<null | (() => void)>(null);
  const tourBeats = useMemo(
    () => buildTour(property.plan, property.label || "This house", streetStart?.kerb ? { kerb: streetStart.kerb, door: streetStart.door } : null),
    [property.plan, property.label, streetStart],
  );

  const onTourBeat = useCallback((beat: Beat | null) => {
    setTourCaption(beat?.caption ?? "");
    setTourBeatKind(beat?.kind ?? null);
  }, []);

  const finishTour = useCallback(() => {
    setTouring(false);
    setTourCaption("");
    setTourBeatKind(null);
    stopRecording.current?.();
    stopRecording.current = null;
    setRecording(false);
    // Back to where the tour opens: the kerb, or the dollhouse.
    setView(defaultView);
  }, [defaultView]);

  const startTour = useCallback(
    (record: boolean) => {
      if (tourBeats.length === 0) return;
      setView({ mode: "dollhouse" });
      setTouring(true);

      if (!record) return;
      const canvas = document.querySelector("canvas");
      if (!(canvas instanceof HTMLCanvasElement)) return;
      setRecording(true);
      stopRecording.current = recordCanvas(canvas, tourDuration(tourBeats), (blob) => {
        setRecording(false);
        if (blob.size === 0) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${property.id}-tour.${blob.type.includes("mp4") ? "mp4" : "webm"}`;
        a.click();
        // Revoked on a delay: revoking immediately can cancel the download in
        // some browsers before it has read the blob.
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      });
    },
    [tourBeats, property.id],
  );

  // How far the house is pulled apart. Walking through a house in pieces makes
  // no sense, so entering walk mode puts it back together.
  const [explode, setExplode] = useState(0);

  /**
   * Whether somebody else's furniture is in the house.
   *
   * Off by default, and that is the honest default rather than the tidy one.
   * The bed and the sofa in a listing photograph belong to the seller and will
   * not be there on completion; what is being modelled is the building. The
   * fixtures stay either way - a bath, a WC, a run of counter - because those
   * are part of what is being bought and part of what the scope prices.
   */
  const [furnished, setFurnished] = useState(false);
  /**
   * Whether the buildings next door are drawn.
   *
   * On by default: how a house sits among its neighbours is half of what a
   * photograph of it shows. Off when they are in the way of the house.
   */
  const [showNeighbours, setShowNeighbours] = useState(true);
  const hasSurroundings = useMemo(() => siteInPlan(property.site) !== null, [property.site]);

  // Which storey the drawing shows. Separate from the dollhouse's floor filter:
  // a plan is always of one floor, whereas the model can show them stacked.
  const [planLevel, setPlanLevel] = useState(0);

  // The rail costs 320px of a 3D view, so it collapses to a spine.
  const [railCollapsed, setRailCollapsed] = useState(false);

  /**
   * Whether the browser has taken over from the server render.
   *
   * `MediaRecorder` does not exist on the server, so asking whether it can
   * encode video returns nothing there and something here - and React then
   * finds the server's HTML and the client's disagreeing and throws the whole
   * tree away to re-render it. Deciding after mount is the fix; the button
   * appears a frame later, which nobody sees.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  /**
   * How hard to render, decided once the browser is actually here.
   *
   * Not during the first render: `navigator.hardwareConcurrency` and
   * `matchMedia` do not exist on the server, so deciding early would give the
   * server and the client different answers and throw the whole tree away -
   * the same hydration trap the `mounted` flag above already exists for.
   */
  // Decided once the canvas exists, because the one thing the device cannot
  // lie about is the renderer's name - a headless browser reports a dozen
  // cores and draws with a CPU.
  const [quality, setQuality] = useState<Quality>("medium");

  /**
   * Escape lets go of the room.
   *
   * Only in the dollhouse. On foot Escape is how the browser hands back the
   * pointer, and stealing it would leave someone locked into a first-person
   * view with no way out - which is a far worse outcome than having to click
   * "Whole house".
   */
  useEffect(() => {
    if (!focusRoomId || view.mode === "walk") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFocusRoomId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusRoomId, view.mode]);



  const bom = useMemo(
    () =>
      onPropertyChange
        ? buildBom(
            property.plan,
            property.condition,
            property.rates,
            property.houseCondition,
            property.kind ?? "house",
          )
        : null,
    [property, onPropertyChange],
  );

  /**
   * Grade one element, without writing the photographs away.
   *
   * The property this component holds is **hydrated**: its `idb:` references
   * have been swapped for object URLs so the shells can load. Saving that back
   * persisted `blob:` URLs over the only pointers to the photographs, and they
   * are dead the moment the page reloads - so grading a single worktop quietly
   * emptied the tour, and took the repair path with it, since
   * `FinishProcessing` looks for references beginning `idb:` and would find
   * none.
   *
   * So the condition is written onto the *stored* document, which still has its
   * references, and only the in-memory copy keeps the hydrated ones. Every other
   * consumer already re-reads the unhydrated document for this reason; this was
   * the one that did not.
   */
  const grade = useCallback(
    (roomId: string, element: Element, value: Grade) => {
      const condition = {
        ...property.condition,
        [roomId]: { ...(property.condition[roomId] ?? {}), [element]: value },
      };

      // `?? property` is for the bundled samples, which are graded like any
      // other tour but have never been in localStorage - `resolveProperty` fell
      // through to fetching them. Falling back is safe for exactly those,
      // because their photographs are plain paths that `resolveMediaUrl`
      // returns unchanged, so their hydrated and stored forms are identical.
      const stored = loadProperty(property.id) ?? property;
      saveProperty({ ...stored, condition });
      // The screen keeps the hydrated photographs. Handing it `stored` would
      // trade a persistence bug for a rendering one: every live object URL
      // would revert to an `idb:` reference and every shell would fail to load.
      onPropertyChange?.({ ...property, condition });
    },
    [property, onPropertyChange],
  );

  /**
   * Persist a spec correction without writing the photographs away.
   *
   * The same trap the grading callback documents: the property this component
   * holds is hydrated, so its `idb:` photo references have been swapped for
   * object URLs. Saving that back would persist `blob:` URLs over the only
   * pointers to the pictures, and they die on the next reload. So the edit goes
   * onto the *stored* document, which still has its references, and only the
   * in-memory copy keeps the live ones.
   */
  const saveEdit = useCallback(
    (edited: Property) => {
      const stored = loadProperty(edited.id) ?? edited;
      saveProperty({ ...stored, spec: edited.spec });
      onPropertyChange?.(edited);
    },
    [onPropertyChange],
  );

  const activeRoom = focusRoomId
    ? property.plan.rooms.find((r) => r.id === focusRoomId) ?? null
    : null;

  /**
   * Double click: stand in that room.
   *
   * Focused first, so backing out of walk mode leaves you looking at the room
   * you were in rather than at the whole house again.
   */
  const enterRoom = useCallback(
    (roomId: string) => {
      const room = property.plan.rooms.find((r) => r.id === roomId);
      if (!room) return;
      setFocusRoomId(roomId);
      setPick({ roomId, element: null });
      setWalkStart(walkStartFor(property.plan, room));
      setExplode(0);
      setView({ mode: "walk" });
      const url = new URL(window.location.href);
      url.searchParams.set("room", roomId);
      window.history.replaceState(null, "", url);
    },
    [property.plan],
  );

  /** Walking across a threshold moves the scope with you, unasked. */
  const walkedInto = useCallback((roomId: string | null) => {
    setFocusRoomId(roomId);
    if (roomId) setPick({ roomId, element: null });
  }, []);

  const showDollhouse = useCallback(() => {
    setView({ mode: "dollhouse" });
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState(null, "", url);
  }, []);

  /** From the kerb, whole house, nothing pulled apart. */
  const showStreet = useCallback(() => {
    setExplode(0);
    setFocusRoomId(null);
    setView({ mode: "street" });
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState(null, "", url);
  }, []);

  /**
   * Exit: back to where the tour opened, from anywhere.
   *
   * One button that always does the same thing. On foot the only way out
   * used to be the header, which the pointer lock made unreachable; from a
   * tour, the plan, a focused room, a house pulled apart - each had its own
   * way back or none. This is all of them: let the pointer go, stop the
   * tour, put the house together, drop the focus, forget where the walker
   * was to be dropped, and stand at the kerb or over the dollhouse.
   */
  const exitToDefault = useCallback(() => {
    if (typeof document !== "undefined" && document.pointerLockElement) document.exitPointerLock?.();
    setTouring(false);
    setTourCaption("");
    setTourBeatKind(null);
    stopRecording.current?.();
    stopRecording.current = null;
    setRecording(false);
    setWalkStart(null);
    setFocusRoomId(null);
    setPick(null);
    setExplode(0);
    setOnlyLevel(null);
    setView(defaultView);
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState(null, "", url);
  }, [defaultView]);

  /**
   * Escape on foot, once the pointer is free, is Exit.
   *
   * The first Escape is the browser's: it hands the pointer back, and
   * stealing it would leave someone locked in. The second, with the pointer
   * free, is a person saying "out".
   */
  useEffect(() => {
    if (view.mode !== "walk") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitToDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.mode, exitToDefault]);

  /**
   * `?room=` drops you inside that room, on your feet.
   *
   * After mount rather than in the initial state, because it walks: `enterRoom`
   * needs the plan to have been measured for a standing spot, and running it
   * during the first render would set state on a component that has not
   * finished rendering yet.
   */
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current) return;
    deepLinked.current = true;
    const wanted = new URLSearchParams(window.location.search).get("room");
    if (wanted && property.plan.rooms.some((r) => r.id === wanted)) enterRoom(wanted);
  }, [property.plan.rooms, enterRoom]);

  return (
    <div className="app-shell">
      <header className="flex flex-wrap items-center justify-between gap-y-2 border-b border-ink-600 bg-ink-800 px-4 py-2.5">
        <div className="flex min-w-0 shrink items-baseline gap-3">
          {/* Operator-only, on the same gate as Scope and Edit below. A
              published tour is somebody else's listing opened from a link;
              there is no property list of theirs to go back to. */}
          {onPropertyChange && (
            <Link
              href="/"
              className="shrink-0 whitespace-nowrap text-xs text-mist-400 transition hover:text-mist-200"
            >
              &larr; All properties
            </Link>
          )}
          <span className="truncate text-sm font-semibold tracking-tight">
            {property.label || property.id}
          </span>
          <span className="hidden shrink-0 whitespace-nowrap text-xs text-mist-400 lg:inline">
            {property.plan.rooms.length} rooms &middot; built from {property.nodes.length + (property.exteriorPhotos?.length ?? 0)}{" "}
            {property.nodes.length === 1 ? "photo" : "photos"}
          </span>
        </div>

        {/* Wraps rather than overflowing. There are enough controls here now
            that a narrow window used to push the last of them off the edge. */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {levels.length > 1 && view.mode === "dollhouse" && (
            <div className="mr-1 flex items-center gap-1">
              <button
                onClick={() => setOnlyLevel(null)}
                className={`rounded px-2.5 py-1 text-xs transition ${
                  onlyLevel === null
                    ? "bg-accent text-ink-900"
                    : "border border-ink-500 text-mist-200 hover:bg-ink-600"
                }`}
              >
                All floors
              </button>
              {levels.map((l) => (
                <button
                  key={l}
                  onClick={() => setOnlyLevel(l)}
                  className={`rounded px-2.5 py-1 text-xs transition ${
                    onlyLevel === l
                      ? "bg-accent text-ink-900"
                      : "border border-ink-500 text-mist-200 hover:bg-ink-600"
                  }`}
                >
                  {levelName(l)}
                </button>
              ))}
            </div>
          )}
          {activeRoom && (
            <span className="rounded bg-ink-600 px-2 py-1 text-xs text-mist-200">
              {activeRoom.label}
            </span>
          )}
          <button
            onClick={exitToDefault}
            data-exit-view
            title="Back to where the tour opens"
            className="rounded border border-accent/60 px-3 py-1 text-xs text-accent transition hover:bg-ink-600"
          >
            Exit
          </button>
          <button
            onClick={() => {
              setExplode(0);
              setView({ mode: "plan" });
            }}
            disabled={view.mode === "plan"}
            className="rounded border border-ink-500 px-3 py-1 text-xs text-mist-200 transition hover:bg-ink-600 disabled:opacity-35"
          >
            Plan
          </button>
          <button
            onClick={showDollhouse}
            disabled={view.mode === "dollhouse"}
            className="rounded border border-ink-500 px-3 py-1 text-xs text-mist-200 transition hover:bg-ink-600 disabled:opacity-35"
          >
            Dollhouse
          </button>
          <button
            onClick={showStreet}
            data-street-toggle
            disabled={view.mode === "street"}
            className="rounded border border-ink-500 px-3 py-1 text-xs text-mist-200 transition hover:bg-ink-600 disabled:opacity-35"
          >
            Street
          </button>
          {/* Only a house that knows its neighbours can hide them. */}
          {hasSurroundings && (
            <button
              onClick={() => setShowNeighbours((v) => !v)}
              data-neighbours-toggle
              className={`rounded border px-3 py-1 text-xs transition ${
                showNeighbours
                  ? "border-ink-500 text-mist-200 hover:bg-ink-600"
                  : "border-ink-600 text-mist-500 hover:bg-ink-600"
              }`}
            >
              Neighbours
            </button>
          )}
          <button
            onClick={() => (touring ? finishTour() : startTour(false))}
            data-tour-toggle
            disabled={view.mode === "plan"}
            className={`rounded border px-3 py-1 text-xs transition disabled:opacity-35 ${
              touring
                ? "border-accent bg-accent text-ink-900"
                : "border-ink-500 text-mist-200 hover:bg-ink-600"
            }`}
          >
            {touring ? "Stop" : "Tour"}
          </button>
          {mounted && supportedFormat() && (
            <button
              onClick={() => startTour(true)}
              disabled={touring || view.mode === "plan"}
              title={`Records a ${Math.round(tourDuration(tourBeats) / 1000)}s film of the house`}
              className="rounded border border-ink-500 px-3 py-1 text-xs text-mist-200 transition hover:bg-ink-600 disabled:opacity-35"
            >
              {recording ? "Recording…" : "Record"}
            </button>
          )}
          <select
            value={scheme.name}
            onChange={(e) => setSchemeName(e.target.value)}
            aria-label="Interior scheme"
            title={scheme.blurb}
            className="rounded border border-ink-500 bg-ink-700 px-2 py-1 text-xs text-mist-200 outline-none focus:border-accent-dim"
          >
            {schemes.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              setMeasuring((on) => !on);
              setMeasurePoints({ a: null, b: null });
            }}
            data-measure-toggle
            disabled={view.mode === "plan"}
            className={`rounded border px-3 py-1 text-xs transition disabled:opacity-35 ${
              measuring
                ? "border-accent bg-accent text-ink-900"
                : "border-ink-500 text-mist-200 hover:bg-ink-600"
            }`}
          >
            Measure
          </button>
          <button
            onClick={() => setFurnished((on) => !on)}
            data-furnished-toggle
            title={
              furnished
                ? "Showing the seller's furniture. The building is what you are buying."
                : "Empty, but still plumbed: the bath, the WC and the counters stay."
            }
            className={`rounded border px-3 py-1 text-xs transition ${
              furnished
                ? "border-accent bg-accent text-ink-900"
                : "border-ink-500 text-mist-200 hover:bg-ink-600"
            }`}
          >
            Furniture
          </button>
          {view.mode === "dollhouse" && (
            <label className="mr-1 flex items-center gap-1.5 text-[11px] text-mist-400">
              Explode
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={explode}
                aria-label="Explode the house"
                onChange={(e) => setExplode(Number(e.target.value))}
                className="w-24 accent-accent"
              />
            </label>
          )}
          <select
            value={quality}
            onChange={(e) => setQuality(e.target.value as Quality)}
            aria-label="Render quality"
            title="How much rendering this machine does. Drop it if the view stutters."
            className="rounded border border-ink-500 bg-ink-700 px-2 py-1 text-xs text-mist-200 outline-none focus:border-accent-dim"
          >
            {(Object.keys(QUALITY_LABEL) as Quality[]).map((q) => (
              <option key={q} value={q}>
                {QUALITY_LABEL[q]}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              setExplode(0);
              setView({ mode: "walk" });
            }}
            disabled={view.mode === "walk" || view.mode === "plan"}
            className="rounded border border-ink-500 px-3 py-1 text-xs text-mist-200 transition hover:bg-ink-600 disabled:opacity-35"
          >
            Walk
          </button>
          {onPropertyChange && <PublishPanel property={property} />}
          {onPropertyChange && (
            <a
              href={`/bom/${property.id}`}
              className="rounded border border-ink-500 px-3 py-1 text-xs text-mist-200 transition hover:bg-ink-600"
            >
              Scope
            </a>
          )}
          {onPropertyChange && (
            <a
              href={`/editor?id=${property.id}`}
              className="rounded border border-ink-500 px-3 py-1 text-xs text-mist-200 transition hover:bg-ink-600"
            >
              Edit
            </a>
          )}
        </div>
      </header>

      {/* The rail sits outside the relative wrapper on purpose: the hint bar and
          the tour caption are centred with `left-1/2`, and inside they would
          centre on the window rather than on the 3D view. */}
      <div className="flex min-h-0 flex-1">
        {bom && (
          <ScopeRail
            bom={bom}
            pick={pick}
            condition={pick ? property.condition[pick.roomId] ?? {} : {}}
            onGrade={grade}
            focusRoomId={focusRoomId}
            onSelectRoom={(roomId) => {
              // On foot, naming a room in the rail is asking to be taken
              // there, the way the mini-map does; from above it is a focus.
              if (view.mode === "walk") {
                enterRoom(roomId);
                return;
              }
              setPick({ roomId, element: null });
              setFocusRoomId(roomId);
            }}
            onClearFocus={() => setFocusRoomId(null)}
            onClear={() => setPick(null)}
            onOpenFull={() => {
              window.location.href = `/bom/${property.id}`;
            }}
            collapsed={railCollapsed}
            onToggle={() => setRailCollapsed((v) => !v)}
          />
        )}

      <div className="relative min-w-0 flex-1">
        {/*
          The plan is a drawing, not a camera angle, so it replaces the canvas
          rather than being another view of it. Everything that steers a camera
          - walking, measuring, the tour - is meaningless while it is showing.
        */}
        {view.mode === "plan" ? (
          <ArchitecturalPlan
            plan={property.plan}
            site={property.site}
            level={planLevel}
            levels={levels}
            onLevel={setPlanLevel}
            displayUnits={property.displayUnits}
            pick={pick}
            onPick={onPropertyChange ? setPick : undefined}
            furnished={furnished}
            spec={property.spec}
          />
        ) : (
        <Canvas
          // Clicking the sky is the other half of clicking a room, and R3F
          // hands it over for free: this fires only when a click hit nothing.
          onPointerMissed={(event) => {
            if (view.mode === "walk") return;
            // The second click of a double-click. The first one focused a
            // room and sent the camera flying, and on a slow renderer a whole
            // frame passes before the second lands - so the pixel that held
            // the room a moment ago holds sky or a wall now, and the click
            // that meant "walk in" was arriving as "let go". The room the
            // first click chose is the room meant.
            if (event.detail >= 2 && focusRoomId) {
              enterRoom(focusRoomId);
              return;
            }
            setFocusRoomId(null);
          }}
          camera={{ fov: 60, near: 0.05, far: 200 }}
          dpr={[1, MAX_DPR[quality]]}
          shadows="soft"
          // `antialias` is off because the composer replaces the framebuffer
          // it would apply to; SMAA in the effect stack is what replaces it.
          // Leaving it true costs a multisampled buffer that is allocated and
          // then never resolved to the screen.
          gl={{ antialias: false }}
          onCreated={({ gl }) => {
            // Tone mapping deliberately left off *here*.
            //
            // The filmic curve is still applied - it is what stops a sunlit
            // floor clipping to a white slab - but it now runs at the end of
            // the effect stack in `Post`, which is where it belongs: after
            // bloom rather than before it. Setting it in both places applies
            // it twice, and the result is a flat, washed image that looks like
            // a rendering problem and is actually an arithmetic one.
            gl.toneMapping = THREE.NoToneMapping;
            setQuality(detectQuality(rendererName(gl.getContext())));
          }}
          className="touch-none"
        >
          <color attach="background" args={["#0f1216"]} />
          <Scene
            property={property}
            view={view}
            onlyLevel={view.mode === "dollhouse" ? onlyLevel : null}
            pick={pick}
            onPick={onPropertyChange ? setPick : undefined}
            dayOfYear={dayOfYearValue}
            hour={hour}
            explode={explode}
            measuring={measuring}
            measurePoints={measurePoints}
            onMeasurePoint={addMeasurePoint}
            scheme={scheme}
            tourBeats={tourBeats}
            touring={touring}
            onTourBeat={onTourBeat}
            onTourFinish={finishTour}
            focusRoomId={focusRoomId}
            onFocusRoom={setFocusRoomId}
            onEnterRoom={enterRoom}
            onWalkRoom={walkedInto}
            walkStart={walkStart}
            quality={quality}
            furnished={furnished}
            showNeighbours={showNeighbours}
            streetStart={streetStart}
            tourBeatKind={tourBeatKind}
          />
        </Canvas>
        )}


        {/*
          The photographs, beside the model rather than on it.

          They are the evidence the replica was built from, and the question
          they answer - "is that really what the kitchen looks like?" - is one
          you ask while looking at the room, not instead of looking at it.
        */}
        {/*
          Above the walk-mode click-catcher.

          That overlay is `inset-0` because it exists to take pointer lock from
          a click anywhere on the view, and it comes later in the document - so
          it sat on top of both panels and swallowed every click at them. The
          effect was that on foot, which is precisely where you want to check a
          room against its photographs, neither panel could be opened at all.
        */}
        <div className="absolute right-3 top-3 z-20 w-64">
          <Evidence property={property} roomId={focusRoomId} />
          {/* Directly under the photographs, because "is that really what the
              kitchen looks like?" is a question you ask with the picture in
              front of you. */}
          <RoomSpecPanel
            property={property}
            roomId={focusRoomId}
            onPropertyChange={onPropertyChange ? saveEdit : undefined}
          />
          {/* The outside, when the whole house is what is being looked at
              and a photograph of it was read. */}
          {focusRoomId === null && property.spec?.exterior && (
            <ExteriorSpecPanel property={property} onPropertyChange={onPropertyChange ? saveEdit : undefined} />
          )}
        </div>

        {/* A small plan floating over a large one is just a smaller plan. */}
        {view.mode !== "plan" && (
          <Minimap
            property={property}
            activeRoomId={focusRoomId}
            onlyLevel={onlyLevel}
            onSelectRoom={enterRoom}
          />
        )}

        {/*
          The surface that takes pointer lock.
          
          A browser will only capture the mouse in response to a real click, so
          walking needs something to click before it can begin. Making that an
          explicit panel rather than the bare canvas also gives somewhere to put
          the controls, which are not guessable - nothing on screen says WASD.
        */}
        {/*
          On foot: a pad for a finger or for anyone who would rather press
          than click, and the way out. Click on the canvas walks; a drag
          looks; these press the same keys the keyboard does.
        */}
        {view.mode === "walk" && (
          <div
            data-walk-ui
            className="absolute bottom-32 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg bg-ink-800/85 px-3 py-2 backdrop-blur"
          >
            <WalkPad k="q" label="↺" title="Turn left (Q)" />
            <div className="grid grid-cols-3 gap-1">
              <span />
              <WalkPad k="w" label="▲" title="Forward (W)" />
              <span />
              <WalkPad k="a" label="◀" title="Left (A)" />
              <WalkPad k="s" label="▼" title="Back (S)" />
              <WalkPad k="d" label="▶" title="Right (D)" />
            </div>
            <WalkPad k="e" label="↻" title="Turn right (E)" />
            <span className="mx-1 hidden text-[11px] leading-tight text-mist-400 sm:block">
              Click where you want to stand
              <br />
              drag to look around
            </span>
            <button
              data-exit-walk
              onClick={exitToDefault}
              className="rounded border border-accent/60 px-3 py-1.5 text-xs text-accent transition hover:bg-ink-600"
            >
              Exit
            </button>
          </div>
        )}

        {/*
          The caption for the beat being shown.
          
          On screen only. `captureStream` carries what WebGL draws and nothing
          else, so HTML over the canvas is absent from the recording - burning
          captions in would mean rendering text inside the scene.
        */}
        {touring && tourCaption && (
          <div
            data-tour-caption
            className="pointer-events-none absolute bottom-16 left-1/2 -translate-x-1/2 rounded bg-ink-800/85 px-4 py-2 text-sm text-mist-200 backdrop-blur"
          >
            {tourCaption}
          </div>
        )}



        {/*
          Daylight controls, shown only when the house has coordinates.
          
          Offering a time-of-day slider on a model that does not know where it
          is would be decoration pretending to be information - the sun would
          move and mean nothing. Where the address gave us a parcel, it means
          exactly what it says.
        */}
        {property.site && (
          <div className="absolute bottom-3 left-3 rounded-lg border border-ink-600 bg-ink-800/90 px-3 py-2.5 backdrop-blur">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-[10px] uppercase tracking-wide text-mist-400">Daylight</span>
              <span className="text-[11px] tabular-nums text-mist-200">
                {formatHour(hour)} · {MONTHS[monthOf(dayOfYearValue)]}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={24}
              step={0.25}
              value={hour}
              aria-label="Time of day"
              onChange={(e) => setHour(Number(e.target.value))}
              className="mt-1.5 w-48 accent-accent"
            />
            <input
              type="range"
              min={1}
              max={365}
              step={1}
              value={dayOfYearValue}
              aria-label="Day of year"
              onChange={(e) => setDayOfYearValue(Number(e.target.value))}
              className="mt-1 w-48 accent-accent"
            />
            <div className="mt-1 text-[10px] text-mist-400" data-sun-altitude>
              Sun {Math.round(solarPosition(property.site, dayOfYearValue, hour).altitudeDeg)}° up,
              bearing {Math.round(solarPosition(property.site, dayOfYearValue, hour).azimuthDeg)}°
            </div>
            {/* The map's licence asks for the credit wherever its data is
                drawn, and the lot is a guess and should say so. */}
            {hasSurroundings && (
              <div className="mt-1 text-[10px] text-mist-500" data-site-attribution>
                Map data © OpenStreetMap contributors · lot boundary estimated
              </div>
            )}
          </div>
        )}

        {view.mode !== "plan" && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-ink-800/85 px-3 py-1.5 text-[11px] text-mist-400 backdrop-blur">
          {view.mode === "dollhouse"
            ? "Drag to orbit · scroll to zoom · double-click a room to walk in"
            : view.mode === "street"
              ? "From the kerb · drag to walk round the house · scroll to come closer · double-click a room to walk in"
              : view.mode === "walk"
              ? "Walking · click where you want to stand · drag to look around · W A S D · Esc to leave"
              : measuring
                ? "Click two points to measure between them"
                : "Drag to look"}
        </div>
        )}

        {property.plan.rooms.length === 0 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <p className="rounded bg-ink-800/90 px-4 py-3 text-sm text-mist-400">
              Nothing built yet. Open the editor to draw a plan.
            </p>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
