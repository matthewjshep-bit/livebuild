"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CameraRig, type TransitionState, type ViewState } from "@/components/tour/CameraRig";
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
import { buildBom } from "@/lib/bom/build";
import type { Element, Grade } from "@/lib/bom/condition";
import type { Pick } from "@/lib/bom/pickable";
import { loadProperty, saveProperty } from "@/lib/property-store";
import { NodeMarkers } from "@/components/tour/NodeMarkers";
import { FinishProcessing } from "@/components/tour/FinishProcessing";
import { Minimap } from "@/components/tour/Minimap";
import { PublishPanel } from "@/components/tour/PublishPanel";
import { FlatShell, PhotoShell } from "@/components/tour/PhotoShell";
import { walkStartFor } from "@/lib/model/focus";
import { levelName, levelsOf, nodeBaseY } from "@/lib/plan/geometry";
import {
  SHELL_MOUNT_M,
  TOUR_REACH_M,
  WALK_REACH_M,
  shellProximity,
} from "@/lib/render/proximity";
import { hydrateMedia } from "@/lib/property-store";
import type { Plan, Property, TourNode } from "@/lib/schema";

/**
 * How opaque a shell should be for a given transition.
 *
 * The outgoing shell holds until the camera is well into the move and only then
 * gives way. Cross-fading from the very first frame would dissolve the two
 * photos into each other and read as a slide transition; holding, then handing
 * over late, reads as having walked somewhere.
 */
function shellOpacity(nodeId: string, { fromNodeId, toNodeId, t }: TransitionState): number {
  if (toNodeId === null) return 0; // dollhouse: photos are out of the way
  if (nodeId === toNodeId) return t < 0.35 ? 0 : (t - 0.35) / 0.65;
  if (nodeId === fromNodeId) return t < 0.35 ? 1 : Math.max(0, 1 - (t - 0.35) / 0.5);
  return 0;
}

/**
 * Inside a room the dollhouse stays almost solid, acting as the backdrop behind
 * the shell's holes.
 *
 * Those holes are real occlusions - the sofa hid that floor from the lens and
 * nothing was ever recorded there. Showing the extruded room through them reads
 * as "something is behind that", which is true. Showing black reads as a bug.
 */
const BACKDROP_OPACITY = 0.9;

function dollhouseOpacity({ toNodeId, t }: TransitionState): number {
  const inside = toNodeId !== null;
  const target = inside ? BACKDROP_OPACITY : 1;
  const other = inside ? 1 : BACKDROP_OPACITY;
  return other + (target - other) * t;
}

/**
 * Which photograph the camera is close enough to be shown, and how strongly.
 *
 * One at a time, and the nearest. The shell material writes depth, so two
 * half-faded shells overlapping would z-fight rather than blend - and standing
 * between two viewpoints ought to resolve to the one you are actually nearer,
 * not to a double exposure.
 *
 * Two callers, one rule. On foot it hunts for whatever viewpoint you have
 * wandered near; on a scripted tour the beat has already named one and the only
 * question is how far the camera still has to fly. Both then fade by distance,
 * which is what makes a photograph bloom in as the tour arrives instead of
 * cutting.
 *
 * The live value goes into a ref the shell reads per frame, and only the
 * quantised one reaches React - the same trick `DollhouseOpacityDriver` uses,
 * for the same reason: this runs at 60Hz and must not cost a render.
 */
function NearbyShellDriver({
  plan,
  nodes,
  levelOf,
  walkState,
  mode,
  tourNodeId,
  opacity,
  onNodeChange,
  onOpacityChange,
}: {
  plan: Property["plan"];
  nodes: TourNode[];
  levelOf: Map<string, number>;
  walkState: React.MutableRefObject<WalkState>;
  mode: "walk" | "tour" | "off";
  tourNodeId: string | null;
  opacity: React.MutableRefObject<number>;
  onNodeChange: (nodeId: string | null) => void;
  onOpacityChange: (value: number) => void;
}) {
  const camera = useThree((s) => s.camera);
  const lastNode = useRef<string | null>(null);
  const lastOpacity = useRef(-1);

  useFrame(() => {
    let nearest: TourNode | null = null;

    if (mode === "tour") {
      nearest = tourNodeId ? nodes.find((n) => n.id === tourNodeId) ?? null : null;
    } else if (mode === "walk") {
      const walk = walkState.current;
      let best = SHELL_MOUNT_M;
      for (const node of nodes) {
        if ((levelOf.get(node.id) ?? 0) !== walk.level) continue;
        const distance = Math.hypot(node.position[0] - walk.x, node.position[1] - walk.y);
        if (distance < best) {
          best = distance;
          nearest = node;
        }
      }
    }

    const nodeId = nearest?.id ?? null;
    if (nodeId !== lastNode.current) {
      lastNode.current = nodeId;
      onNodeChange(nodeId);
    }

    opacity.current = nearest
      ? shellProximity(
          nearest,
          nodeBaseY(plan, nearest),
          camera.position,
          mode === "tour" ? TOUR_REACH_M : WALK_REACH_M,
        )
      : 0;

    // A readout for the browser suite, alongside WalkControls' own `__walk`.
    // Whether a photograph is actually on screen cannot be seen from outside
    // the canvas any other way.
    (window as unknown as { __shell?: unknown }).__shell = {
      nodeId,
      opacity: opacity.current,
    };

    const quantised = Math.round(opacity.current * 30) / 30;
    if (quantised !== lastOpacity.current) {
      lastOpacity.current = quantised;
      onOpacityChange(quantised);
    }
  });

  return null;
}

function Scene({
  property,
  view,
  transition,
  onlyLevel,
  pick,
  onPick,
  onSelectNode,
  dayOfYear,
  hour,
  explode,
  measuring,
  measurePoints,
  onMeasurePoint,
  scheme,
  tourBeats,
  touring,
  tourNodeId,
  onTourBeat,
  onTourFinish,
  focusRoomId,
  onFocusRoom,
  onEnterRoom,
  onWalkRoom,
  walkStart,
}: {
  property: Property;
  view: ViewState;
  transition: React.MutableRefObject<TransitionState>;
  onlyLevel: number | null;
  pick: Pick | null;
  onPick?: (pick: Pick) => void;
  onSelectNode: (id: string) => void;
  dayOfYear: number;
  hour: number;
  explode: number;
  measuring: boolean;
  measurePoints: MeasurePoints;
  onMeasurePoint: (point: THREE.Vector3) => void;
  scheme: Scheme;
  tourBeats: ReturnType<typeof buildTour>;
  touring: boolean;
  /** The viewpoint the running beat stands in, when it names one. */
  tourNodeId: string | null;
  onTourBeat: (beat: Beat | null) => void;
  onTourFinish: () => void;
  /** The room being looked at on its own, or null for the whole house. */
  focusRoomId: string | null;
  onFocusRoom: (roomId: string | null) => void;
  onEnterRoom: (roomId: string) => void;
  onWalkRoom: (roomId: string | null) => void;
  walkStart: { position: [number, number]; level: number; yaw: number } | null;
}) {
  const [dollOpacity, setDollOpacity] = useState(1);
  // Which storey the walker is standing on, which changes under them on the
  // stairs rather than being chosen from the toolbar.
  const [walkLevel, setWalkLevel] = useState(0);
  const walkState = useRef<WalkState>({ x: 0, y: 0, level: 0, yaw: 0 });

  // The photograph the camera is standing in, if any - hunted for on foot,
  // named by the beat on a scripted tour. The id drives what gets mounted; the
  // ref carries the live fade, which the shell reads per frame.
  const [nearbyNodeId, setNearbyNodeId] = useState<string | null>(null);
  const [shellFade, setShellFade] = useState(0);
  const shellOpacityRef = useRef(0);

  // A node's storey is a property of its room, not of the photo.
  const levelOf = useMemo(() => {
    const rooms = new Map(property.plan.rooms.map((r) => [r.id, r.level]));
    return new Map(property.nodes.map((n) => [n.id, rooms.get(n.roomId) ?? 0]));
  }, [property.plan.rooms, property.nodes]);
  const aspects = useRef(new Map<string, number>());
  const reportAspect = useCallback((nodeId: string, aspect: number) => {
    aspects.current.set(nodeId, aspect);
  }, []);

  // Keep the active node, wherever we came from, and everything one step away
  // resident. Loading a shell takes long enough to be visible, so a neighbour
  // must already be warm by the time its ring is clicked.
  const resident = useMemo(() => {
    const byId = new Map(property.nodes.map((n) => [n.id, n]));
    const wanted = new Set<string>();
    if (view.mode === "node") {
      wanted.add(view.nodeId);
      for (const id of byId.get(view.nodeId)?.neighbors ?? []) wanted.add(id);
    }
    // The photograph the camera has reached, on foot or on a scripted tour, so
    // both resolve into real photography wherever there is any to resolve into.
    if (nearbyNodeId) wanted.add(nearbyNodeId);
    const from = transition.current.fromNodeId;
    if (from) wanted.add(from);
    return [...wanted].map((id) => byId.get(id)).filter(Boolean) as TourNode[];
  }, [property.nodes, view, transition, nearbyNodeId]);

  /**
   * How solid a shell is, asked once a frame.
   *
   * Walking and stepping ask different questions. Stepping cross-fades between
   * two named nodes; walking - and flying a scripted tour - asks how near the
   * camera is standing to one. Both are answered out of refs rather than props,
   * so the 60Hz read costs no render.
   */
  const opacityFor = useCallback(
    (node: TourNode) =>
      view.mode === "walk" || touring
        ? node.id === nearbyNodeId
          ? shellOpacityRef.current
          : 0
        : shellOpacity(node.id, transition.current),
    [view.mode, touring, nearbyNodeId, transition],
  );

  return (
    <>
      <Lighting
        site={property.site}
        dayOfYear={dayOfYear}
        hour={hour}
        interior={view.mode === "walk" || view.mode === "node"}
        plan={property.plan}
        // Lit indoors, and after dark whatever the view. Nobody wants a
        // dollhouse glowing from inside at midday.
        lamps={view.mode === "walk" || hour < 7.5 || hour > 18.5}
        explode={explode}
      />

      <CameraRig
        plan={property.plan}
        nodes={property.nodes}
        view={view}
        transition={transition}
        aspects={aspects}
        paused={touring}
        explode={explode}
        focusRoomId={focusRoomId}
      />

      <DollhouseOpacityDriver transition={transition} onChange={setDollOpacity} />

      <Model
        plan={property.plan}
        // Inside the house the walls are the thing you are looking at, so the
        // dollhouse's see-through shell would be exactly wrong - until a
        // photograph fades up over them, at which point the model becomes the
        // backdrop behind that shell's occlusion holes exactly as it does in a
        // node, and has to go transparent to be sorted against it rather than
        // z-fight the wall it was shot from.
        opacity={
          view.mode === "walk"
            ? 1 - (1 - BACKDROP_OPACITY) * shellFade
            : Math.min(dollOpacity, 1 - (1 - BACKDROP_OPACITY) * shellFade)
        }
        showLabels={view.mode === "dollhouse"}
        displayUnits={property.displayUnits}
        onlyLevel={view.mode === "walk" ? walkLevel : onlyLevel}
        // The dollhouse only. Standing inside the house - on foot, or in a
        // photograph, or being flown through one by the scripted tour - there is
        // nothing to compare the room against, and ghosting the walls around
        // you does not read as focus. It reads as the building dissolving.
        focusRoomId={view.mode === "dollhouse" && !touring ? focusRoomId : null}
        pick={pick}
        onPick={onPick}
        onFocusRoom={onPick ? (roomId) => onFocusRoom(roomId) : undefined}
        onEnterRoom={onPick ? onEnterRoom : undefined}
        onMeasurePoint={measuring ? onMeasurePoint : undefined}
        walking={view.mode === "walk"}
        scheme={scheme}
        explode={explode}
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

      <NearbyShellDriver
        plan={property.plan}
        nodes={property.nodes}
        levelOf={levelOf}
        walkState={walkState}
        mode={touring ? "tour" : view.mode === "walk" ? "walk" : "off"}
        tourNodeId={tourNodeId}
        opacity={shellOpacityRef}
        onNodeChange={setNearbyNodeId}
        onOpacityChange={setShellFade}
      />

      {resident.map((node) => (
        <Suspense key={node.id} fallback={null}>
          {node.depth ? (
            <PhotoShell
              node={node}
              getOpacity={() => opacityFor(node)}
              onAspect={reportAspect}
              baseY={nodeBaseY(property.plan, node)}
            />
          ) : (
            <FlatShell
              node={node}
              getOpacity={() => opacityFor(node)}
              baseY={nodeBaseY(property.plan, node)}
            />
          )}
        </Suspense>
      ))}

      <NodeMarkers
        plan={property.plan}
        nodes={property.nodes}
        activeNodeId={view.mode === "node" ? view.nodeId : null}
        // Rings are for stepping between photographs; on foot you simply walk,
        // and a drawing has no camera to step into.
        mode={view.mode === "node" ? "node" : "dollhouse"}
        // Stepping into a photograph from a house in pieces means nothing.
        hidden={view.mode === "walk" || explode > 0}
        onlyLevel={onlyLevel}
        onSelect={onSelectNode}
      />
    </>
  );
}

/**
 * Which room the walker is standing in.
 *
 * "Walking into a room shows that room's scope" was the scope pane's founding
 * promise, and on foot it was never true - the effect that does it is gated on
 * having stepped into a *photograph*, and the test that covers it navigates to
 * `?node=` while its comment says "walking into a room". So the first-person
 * mode, the one where you are most obviously in a particular room, was the one
 * mode that never told the rail anything.
 *
 * Reported only when the room actually changes, the same way the photo shells
 * are driven a few lines up: this runs at 60Hz and crossing a threshold is a
 * rare event, so it must not cost a render on the frames where nothing happens.
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

/**
 * The dollhouse fades on a React state update rather than per frame, because
 * its opacity feeds many materials. Quantising to ~30 steps keeps that to a
 * couple of dozen re-renders per transition instead of one per frame.
 */
function DollhouseOpacityDriver({
  transition,
  onChange,
}: {
  transition: React.MutableRefObject<TransitionState>;
  onChange: (value: number) => void;
}) {
  const last = useRef(-1);
  useFrame(() => {
    const next = Math.round(dollhouseOpacity(transition.current) * 30) / 30;
    if (next !== last.current) {
      last.current = next;
      onChange(next);
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

export function TourViewer({
  property,
  onPropertyChange,
}: {
  property: Property;
  onPropertyChange?: (property: Property) => void;
}) {
  // `?node=` deep-links a viewpoint, so a specific spot in a house can be sent
  // to someone directly rather than "open the tour and walk to the kitchen".
  const [view, setView] = useState<ViewState>(() => {
    if (typeof window === "undefined") return { mode: "dollhouse" };
    const wanted = new URLSearchParams(window.location.search).get("node");
    return wanted && property.nodes.some((n) => n.id === wanted)
      ? { mode: "node", nodeId: wanted }
      : { mode: "dollhouse" };
  });
  const transition = useRef<TransitionState>({ fromNodeId: null, toNodeId: null, t: 1 });

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
  const schemes = useMemo(() => schemesFor(property.exterior), [property.exterior]);
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
  // The viewpoint the running beat stands in, when it names one.
  const [tourNodeId, setTourNodeId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const stopRecording = useRef<null | (() => void)>(null);
  // Given the nodes, a room that was photographed is shown from inside its own
  // photograph rather than from above - which is what puts photography in the
  // recorded film at all.
  const tourBeats = useMemo(
    () => buildTour(property.plan, property.label || "This house", property.nodes),
    [property.plan, property.label, property.nodes],
  );

  const onTourBeat = useCallback((beat: Beat | null) => {
    setTourCaption(beat?.caption ?? "");
    setTourNodeId(beat?.nodeId ?? null);
  }, []);

  const finishTour = useCallback(() => {
    setTouring(false);
    setTourCaption("");
    setTourNodeId(null);
    stopRecording.current?.();
    stopRecording.current = null;
    setRecording(false);
  }, []);

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

  const [locked, setLocked] = useState(false);
  useEffect(() => {
    const onChange = () => setLocked(Boolean(document.pointerLockElement));
    document.addEventListener("pointerlockchange", onChange);
    return () => document.removeEventListener("pointerlockchange", onChange);
  }, []);

  const bom = useMemo(
    () =>
      onPropertyChange
        ? buildBom(property.plan, property.condition, property.rates, property.houseCondition)
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

  const activeNode =
    view.mode === "node" ? property.nodes.find((n) => n.id === view.nodeId) ?? null : null;
  const activeRoom = activeNode
    ? property.plan.rooms.find((r) => r.id === activeNode.roomId) ?? null
    : null;

  // Walking into a room shows its scope, because that is the question being
  // asked at the time. Clicking a fixture then narrows to it.
  useEffect(() => {
    if (!onPropertyChange) return;
    if (view.mode !== "node") return;
    const node = property.nodes.find((n) => n.id === view.nodeId);
    if (node) setPick({ roomId: node.roomId, element: null });
  }, [view, property.nodes, onPropertyChange]);

  const selectNode = useCallback((id: string) => {
    setView({ mode: "node", nodeId: id });
    const url = new URL(window.location.href);
    url.searchParams.set("node", id);
    window.history.replaceState(null, "", url);
  }, []);

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
    url.searchParams.delete("node");
    window.history.replaceState(null, "", url);
  }, []);

  return (
    <div className="app-shell">
      <header className="flex items-center justify-between border-b border-ink-600 bg-ink-800 px-4 py-2.5">
        <div className="flex min-w-0 items-baseline gap-3">
          {/* Operator-only, on the same gate as Scope and Edit below. A
              published tour is somebody else's listing opened from a link;
              there is no property list of theirs to go back to. */}
          {onPropertyChange && (
            <a
              href="/"
              className="shrink-0 whitespace-nowrap text-xs text-mist-400 transition hover:text-mist-200"
            >
              &larr; All properties
            </a>
          )}
          <span className="truncate text-sm font-semibold tracking-tight">
            {property.label || property.id}
          </span>
          <span className="text-xs text-mist-400">
            {property.plan.rooms.length} rooms &middot; {property.nodes.length} viewpoints
          </span>
        </div>

        <div className="flex items-center gap-2">
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
          />
        ) : (
        <Canvas
          // Clicking the sky is the other half of clicking a room, and R3F
          // hands it over for free: this fires only when a click hit nothing.
          onPointerMissed={() => {
            if (view.mode !== "walk") setFocusRoomId(null);
          }}
          camera={{ fov: 60, near: 0.05, far: 200 }}
          dpr={[1, 2]}
          shadows="soft"
          // No tone mapping. The default filmic curve exists to tame bright
          // highlights in photographic renders, and here it just drags white
          // walls down to grey - the whole palette is already inside range.
          gl={{ antialias: true }}
          onCreated={({ gl }) => {
            // Filmic tone mapping, which was switched off earlier in the build.
            //
            // It was turned off because it dragged the flat white walls to
            // grey, and with nothing but flat colour on screen that was the
            // right call. Once the surfaces carry grain the trade reverses:
            // the filmic curve is what stops a sunlit floor clipping to a
            // white slab and gives the shading somewhere to go. The exposure
            // lift puts the whites back where they were.
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = 1.0;
          }}
          className="touch-none"
        >
          <color attach="background" args={["#0f1216"]} />
          <Scene
            property={property}
            view={view}
            transition={transition}
            onlyLevel={view.mode === "dollhouse" ? onlyLevel : null}
            pick={pick}
            onPick={onPropertyChange ? setPick : undefined}
            onSelectNode={selectNode}
            dayOfYear={dayOfYearValue}
            hour={hour}
            explode={explode}
            measuring={measuring}
            measurePoints={measurePoints}
            onMeasurePoint={addMeasurePoint}
            scheme={scheme}
            tourBeats={tourBeats}
            touring={touring}
            tourNodeId={tourNodeId}
            onTourBeat={onTourBeat}
            onTourFinish={finishTour}
            focusRoomId={focusRoomId}
            onFocusRoom={setFocusRoomId}
            onEnterRoom={enterRoom}
            onWalkRoom={walkedInto}
            walkStart={walkStart}
          />
        </Canvas>
        )}


        {onPropertyChange && (
          <FinishProcessing
            property={property}
            onUpdated={(updated) => void hydrateMedia(updated).then(onPropertyChange)}
          />
        )}

        {/* A small plan floating over a large one is just a smaller plan. */}
        {view.mode !== "plan" && (
          <Minimap
            property={property}
            activeNodeId={view.mode === "node" ? view.nodeId : null}
            onlyLevel={onlyLevel}
            onSelectNode={selectNode}
          />
        )}

        {/*
          The surface that takes pointer lock.
          
          A browser will only capture the mouse in response to a real click, so
          walking needs something to click before it can begin. Making that an
          explicit panel rather than the bare canvas also gives somewhere to put
          the controls, which are not guessable - nothing on screen says WASD.
        */}
        {view.mode === "walk" && !locked && (
          <div
            data-walk-lock
            className="absolute inset-0 grid place-items-center"
            style={{ cursor: "crosshair" }}
          >
            <div className="rounded-lg bg-ink-800/85 px-5 py-4 text-center backdrop-blur">
              <p className="text-sm text-mist-200">Click to look around</p>
              <p className="mt-1 text-[11px] leading-relaxed text-mist-400">
                W A S D or the arrow keys to move · shift to hurry
                <br />
                Esc to let the pointer go
              </p>
            </div>
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

        {/* A crosshair, so it is obvious where the pointer went. */}
        {view.mode === "walk" && locked && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-mist-200/60" />
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
          </div>
        )}

        {view.mode !== "plan" && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-ink-800/85 px-3 py-1.5 text-[11px] text-mist-400 backdrop-blur">
          {view.mode === "dollhouse"
            ? "Drag to orbit · scroll to zoom · click a ring to step inside"
            : view.mode === "walk"
              ? "Walking · W A S D to move · Esc to release the pointer"
            : measuring
              ? "Click two points to measure between them"
              : "Drag to look · move the pointer to lean · click a ring to walk there"}
        </div>
        )}

        {property.nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <p className="rounded bg-ink-800/90 px-4 py-3 text-sm text-mist-400">
              No viewpoints yet. Open the editor to place photos on the plan.
            </p>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
