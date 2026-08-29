"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CameraRig, type TransitionState, type ViewState } from "@/components/tour/CameraRig";
import { Lighting } from "@/components/tour/Lighting";
import { Measure, type MeasurePoints } from "@/components/tour/Measure";
import { ScriptedTour, recordCanvas, supportedFormat } from "@/components/tour/ScriptedTour";
import { buildTour, tourDuration } from "@/lib/model/tour-script";
import { SCHEMES, type Scheme, schemeByName } from "@/lib/model/schemes";
import { dayOfYear, solarPosition } from "@/lib/model/sun";
import { WalkControls, type WalkState } from "@/components/tour/WalkControls";
import { ScopeRail } from "@/components/bom/ScopeRail";
import { Model } from "@/components/tour/Model";
import { buildBom } from "@/lib/bom/build";
import type { Element, Grade } from "@/lib/bom/condition";
import type { Pick } from "@/lib/bom/pickable";
import { saveProperty } from "@/lib/property-store";
import { NodeMarkers } from "@/components/tour/NodeMarkers";
import { FinishProcessing } from "@/components/tour/FinishProcessing";
import { Minimap } from "@/components/tour/Minimap";
import { PublishPanel } from "@/components/tour/PublishPanel";
import { FlatShell, PhotoShell } from "@/components/tour/PhotoShell";
import { levelName, levelsOf, nodeBaseY } from "@/lib/plan/geometry";
import { hydrateMedia } from "@/lib/property-store";
import type { Property, TourNode } from "@/lib/schema";

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
  measuring,
  measurePoints,
  onMeasurePoint,
  scheme,
  tourBeats,
  touring,
  onTourCaption,
  onTourFinish,
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
  measuring: boolean;
  measurePoints: MeasurePoints;
  onMeasurePoint: (point: THREE.Vector3) => void;
  scheme: Scheme;
  tourBeats: ReturnType<typeof buildTour>;
  touring: boolean;
  onTourCaption: (caption: string) => void;
  onTourFinish: () => void;
}) {
  const [dollOpacity, setDollOpacity] = useState(1);
  // Which storey the walker is standing on, which changes under them on the
  // stairs rather than being chosen from the toolbar.
  const [walkLevel, setWalkLevel] = useState(0);
  const walkState = useRef<WalkState>({ x: 0, y: 0, level: 0, yaw: 0 });
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
    const from = transition.current.fromNodeId;
    if (from) wanted.add(from);
    return [...wanted].map((id) => byId.get(id)).filter(Boolean) as TourNode[];
  }, [property.nodes, view, transition]);

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
      />

      <CameraRig
        plan={property.plan}
        nodes={property.nodes}
        view={view}
        transition={transition}
        aspects={aspects}
        paused={touring}
      />

      <DollhouseOpacityDriver transition={transition} onChange={setDollOpacity} />

      <Model
        plan={property.plan}
        // Inside the house the walls are the thing you are looking at, so the
        // dollhouse's see-through shell would be exactly wrong.
        opacity={view.mode === "walk" ? 1 : dollOpacity}
        showLabels={view.mode === "dollhouse"}
        displayUnits={property.displayUnits}
        onlyLevel={view.mode === "walk" ? walkLevel : onlyLevel}
        pick={pick}
        onPick={onPick}
        onMeasurePoint={measuring ? onMeasurePoint : undefined}
        walking={view.mode === "walk"}
        scheme={scheme}
      />

      <Measure points={measurePoints} displayUnits={property.displayUnits} />

      <ScriptedTour
        beats={tourBeats}
        running={touring}
        onBeat={onTourCaption}
        onFinish={onTourFinish}
      />

      <WalkControls
        plan={property.plan}
        level={walkLevel}
        onLevelChange={setWalkLevel}
        state={walkState}
        enabled={view.mode === "walk"}
      />

      {resident.map((node) => (
        <Suspense key={node.id} fallback={null}>
          {node.depth ? (
            <PhotoShell
              node={node}
              getOpacity={() => shellOpacity(node.id, transition.current)}
              onAspect={reportAspect}
              baseY={nodeBaseY(property.plan, node)}
            />
          ) : (
            <FlatShell
              node={node}
              getOpacity={() => shellOpacity(node.id, transition.current)}
              baseY={nodeBaseY(property.plan, node)}
            />
          )}
        </Suspense>
      ))}

      <NodeMarkers
        plan={property.plan}
        nodes={property.nodes}
        activeNodeId={view.mode === "node" ? view.nodeId : null}
        // Rings are for stepping between photographs; on foot you simply walk.
        mode={view.mode === "walk" ? "dollhouse" : view.mode}
        hidden={view.mode === "walk"}
        onlyLevel={onlyLevel}
        onSelect={onSelectNode}
      />
    </>
  );
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
  const [schemeName, setSchemeName] = useState<string>(SCHEMES[1].name);
  const scheme = schemeByName(schemeName);

  // The scripted tour, and recording it.
  const [touring, setTouring] = useState(false);
  const [tourCaption, setTourCaption] = useState("");
  const [recording, setRecording] = useState(false);
  const stopRecording = useRef<null | (() => void)>(null);
  const tourBeats = useMemo(
    () => buildTour(property.plan, property.label || "This house"),
    [property.plan, property.label],
  );

  const finishTour = useCallback(() => {
    setTouring(false);
    setTourCaption("");
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

  // The rail costs 320px of a 3D view, so it collapses to a spine.
  const [railCollapsed, setRailCollapsed] = useState(false);

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

  const grade = useCallback(
    (roomId: string, element: Element, value: Grade) => {
      const next: Property = {
        ...property,
        condition: {
          ...property.condition,
          [roomId]: { ...(property.condition[roomId] ?? {}), [element]: value },
        },
      };
      saveProperty(next);
      onPropertyChange?.(next);
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

  const showDollhouse = useCallback(() => {
    setView({ mode: "dollhouse" });
    const url = new URL(window.location.href);
    url.searchParams.delete("node");
    window.history.replaceState(null, "", url);
  }, []);

  return (
    <div className="app-shell">
      <header className="flex items-center justify-between border-b border-ink-600 bg-ink-800 px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold tracking-tight">
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
            onClick={showDollhouse}
            disabled={view.mode === "dollhouse"}
            className="rounded border border-ink-500 px-3 py-1 text-xs text-mist-200 transition hover:bg-ink-600 disabled:opacity-35"
          >
            Dollhouse
          </button>
          <button
            onClick={() => (touring ? finishTour() : startTour(false))}
            data-tour-toggle
            className={`rounded border px-3 py-1 text-xs transition ${
              touring
                ? "border-accent bg-accent text-ink-900"
                : "border-ink-500 text-mist-200 hover:bg-ink-600"
            }`}
          >
            {touring ? "Stop" : "Tour"}
          </button>
          {supportedFormat() && (
            <button
              onClick={() => startTour(true)}
              disabled={touring}
              title={`Records a ${Math.round(tourDuration(tourBeats) / 1000)}s film of the house`}
              className="rounded border border-ink-500 px-3 py-1 text-xs text-mist-200 transition hover:bg-ink-600 disabled:opacity-35"
            >
              {recording ? "Recording…" : "Record"}
            </button>
          )}
          <select
            value={schemeName}
            onChange={(e) => setSchemeName(e.target.value)}
            aria-label="Interior scheme"
            title={scheme.blurb}
            className="rounded border border-ink-500 bg-ink-700 px-2 py-1 text-xs text-mist-200 outline-none focus:border-accent-dim"
          >
            {SCHEMES.map((s) => (
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
            className={`rounded border px-3 py-1 text-xs transition ${
              measuring
                ? "border-accent bg-accent text-ink-900"
                : "border-ink-500 text-mist-200 hover:bg-ink-600"
            }`}
          >
            Measure
          </button>
          <button
            onClick={() => setView({ mode: "walk" })}
            disabled={view.mode === "walk"}
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
            onSelectRoom={(roomId) => setPick({ roomId, element: null })}
            onClear={() => setPick(null)}
            onOpenFull={() => {
              window.location.href = `/bom/${property.id}`;
            }}
            collapsed={railCollapsed}
            onToggle={() => setRailCollapsed((v) => !v)}
          />
        )}

      <div className="relative min-w-0 flex-1">
        <Canvas
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
            measuring={measuring}
            measurePoints={measurePoints}
            onMeasurePoint={addMeasurePoint}
            scheme={scheme}
            tourBeats={tourBeats}
            touring={touring}
            onTourCaption={setTourCaption}
            onTourFinish={finishTour}
          />
        </Canvas>


        {onPropertyChange && (
          <FinishProcessing
            property={property}
            onUpdated={(updated) => void hydrateMedia(updated).then(onPropertyChange)}
          />
        )}

        <Minimap
          property={property}
          activeNodeId={view.mode === "node" ? view.nodeId : null}
          onlyLevel={onlyLevel}
          onSelectNode={selectNode}
        />

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

        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-ink-800/85 px-3 py-1.5 text-[11px] text-mist-400 backdrop-blur">
          {view.mode === "dollhouse"
            ? "Drag to orbit · scroll to zoom · click a ring to step inside"
            : view.mode === "walk"
              ? "Walking · W A S D to move · Esc to release the pointer"
            : measuring
              ? "Click two points to measure between them"
              : "Drag to look · move the pointer to lean · click a ring to walk there"}
        </div>

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
