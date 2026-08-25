"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Suspense, useCallback, useMemo, useRef, useState } from "react";

import { CameraRig, type TransitionState, type ViewState } from "@/components/tour/CameraRig";
import { Model } from "@/components/tour/Model";
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
  onSelectNode,
}: {
  property: Property;
  view: ViewState;
  transition: React.MutableRefObject<TransitionState>;
  onlyLevel: number | null;
  onSelectNode: (id: string) => void;
}) {
  const [dollOpacity, setDollOpacity] = useState(1);
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
      {/*
        Architectural lighting: one key light with real shadows, a cool sky fill,
        and very little ambient.
        
        Flat ambient light was what made the old dollhouse read as a diagram -
        every surface came back the same tone, so nothing had form. Shading is
        what separates a wall from the floor it meets, and a soft shadow under
        furniture is most of what makes a room look occupied.
      */}
      <hemisphereLight args={["#eef4fb", "#6f6b64", 1.05]} />
      <ambientLight intensity={0.22} />
      <directionalLight
        position={[9, 16, 7]}
        intensity={1.9}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-22}
        shadow-camera-right={22}
        shadow-camera-top={22}
        shadow-camera-bottom={-22}
        shadow-camera-near={0.5}
        shadow-camera-far={70}
        shadow-bias={-0.0004}
      />
      {/* A weak opposing fill so the shadowed side is shaded, not black. */}
      <directionalLight position={[-8, 6, -6]} intensity={0.32} />

      <CameraRig
        plan={property.plan}
        nodes={property.nodes}
        view={view}
        transition={transition}
        aspects={aspects}
      />

      <DollhouseOpacityDriver transition={transition} onChange={setDollOpacity} />

      <Model
        plan={property.plan}
        opacity={dollOpacity}
        showLabels={view.mode === "dollhouse"}
        displayUnits={property.displayUnits}
        onlyLevel={onlyLevel}
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
        mode={view.mode}
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

  const activeNode =
    view.mode === "node" ? property.nodes.find((n) => n.id === view.nodeId) ?? null : null;
  const activeRoom = activeNode
    ? property.plan.rooms.find((r) => r.id === activeNode.roomId) ?? null
    : null;

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

      <div className="relative flex-1">
        <Canvas
          camera={{ fov: 60, near: 0.05, far: 200 }}
          dpr={[1, 2]}
          shadows="soft"
          // No tone mapping. The default filmic curve exists to tame bright
          // highlights in photographic renders, and here it just drags white
          // walls down to grey - the whole palette is already inside range.
          gl={{ antialias: true, toneMapping: THREE.NoToneMapping }}
          className="touch-none"
        >
          <color attach="background" args={["#0f1216"]} />
          <Scene
            property={property}
            view={view}
            transition={transition}
            onlyLevel={view.mode === "dollhouse" ? onlyLevel : null}
            onSelectNode={selectNode}
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

        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-ink-800/85 px-3 py-1.5 text-[11px] text-mist-400 backdrop-blur">
          {view.mode === "dollhouse"
            ? "Drag to orbit · scroll to zoom · click a ring to step inside"
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
  );
}
