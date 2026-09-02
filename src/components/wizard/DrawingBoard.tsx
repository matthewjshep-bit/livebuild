"use client";

import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { centroid, pointInPolygon } from "@/lib/plan/geometry";
import { type Label, type Stroke, readStrokes, strokesToRooms } from "@/lib/plan/strokes";
import type { Room, Vec2 } from "@/lib/schema";

/**
 * Somewhere to actually draw.
 *
 * The pad this replaces was 1400 by 1000 pixels with no zoom, no pan, an eraser
 * that painted in the paper colour rather than removing anything, and an undo
 * that ate walls while leaving the labels on top of them. It also threw its
 * vectors away: the only thing that left the component was a JPEG, which then
 * went to a vision model to be read back into rectangles.
 *
 * This keeps the pen and gives it room. Strokes stay strokes, and
 * `strokesToRooms` turns them into rooms here in the browser - no request, no
 * key, no waiting, and a refusal that can point at the place in the drawing it
 * is talking about rather than describing it.
 *
 * Drawing and moving are deliberately different gestures. A surface that pans
 * on the same drag that draws leaves a stroke every time somebody tries to
 * shift the paper, so: the pen is the primary pointer, panning is the middle
 * button or space held down, and zooming is the wheel.
 *
 * **The spaces are shown as they close.** This is the change that makes naming
 * possible rather than merely available. `readStrokes` runs on every stroke, so
 * a room appears the moment its last wall lands, hovering lights the one under
 * the cursor, and the name goes to that room's centroid instead of to wherever
 * the pointer happened to be. Before this, "click inside the room" asked
 * somebody to aim at something they could not see, and the first they heard of
 * a miss was a refusal after the fact.
 */

type Tool = "draw" | "name" | "erase";

const PEN_PX = 4;
const ERASER_PX = 34;

const PAPER = "#12151a";
const INK = "#c9d1da";
const GRID = "rgba(120,132,150,0.10)";

/**
 * The roads, and quieter than everything else on the pad.
 *
 * They are there to be glanced at and never to be drawn on, so they sit below
 * the building outline in weight as the outline sits below the ink. A street
 * that competes with the wall somebody is drawing has made the pad worse.
 */
const ROAD = "rgba(150,162,178,0.30)";
const ROAD_NAME = "rgba(168,180,196,0.62)";

/**
 * A space with no name yet, a space with one, and the one under the cursor.
 *
 * Strong enough to be read at a glance rather than merely present. The whole
 * job of the fill is to answer "which rooms has it found" before anybody
 * commits to a name - two rooms that came out as one because a wall missed by a
 * hair have to be *visible* as one shape, and a tint you have to look for does
 * not do that.
 */
const EMPTY_FILL = "rgba(120,160,220,0.18)";
const EMPTY_EDGE = "rgba(120,160,220,0.45)";
const NAMED_FILL = "rgba(126,231,135,0.16)";
const NAMED_EDGE = "rgba(126,231,135,0.45)";
const HOVER_FILL = "rgba(120,160,220,0.34)";
const HOVER_EDGE = "rgba(150,190,240,0.9)";

/** The building's own outline, when the map measured one, to draw inside. */
const GUIDE_FILL = "rgba(242,165,65,0.06)";
const GUIDE_EDGE = "rgba(242,165,65,0.55)";

/** How far clear of the room the naming card stands, and how wide it is. */
const CARD_GAP_PX = 12;
const CARD_WIDTH_PX = 256;

export function DrawingBoard({
  strokes,
  labels,
  onStrokes,
  onLabels,
  wanted = [],
  guide,
  targetGroundSqft,
  onDropWanted,
  onRooms,
  onCancel,
  cancelLabel = "Cancel",
  cta = "Use this drawing",
  notice,
  busy,
}: {
  strokes: Stroke[];
  labels: Label[];
  onStrokes: Dispatch<SetStateAction<Stroke[]>>;
  onLabels: Dispatch<SetStateAction<Label[]>>;
  /** The rooms the house sheet says exist, offered as chips rather than typing. */
  wanted?: string[];
  /**
   * The building as the map measured it, and what a paper pixel is worth.
   *
   * Two things at once, and the second is the more useful. Drawn under the pen
   * it is a shape to trace, so the outline comes out being the building's
   * rather than a rectangle to be repacked later. And it fixes the pad's scale,
   * so the rooms leave here already in real metres instead of in the "sixteen
   * square metres a room" guess a drawing otherwise has to make.
   */
  guide?: {
    outline: Vec2[];
    metresPerPixel: number;
    /** The roads round the building, in the same metres as the outline. */
    streets?: Array<{ name: string; ways: Vec2[][] }>;
  } | null;
  /** This floor's area, when somebody typed one. The drawing has no scale. */
  targetGroundSqft?: number;
  /** Take a room off the sheet, for one that turned out not to be drawn. */
  onDropWanted?: (label: string) => void;
  /** The rooms read out of the drawing, in the drawing's own metres. */
  onRooms: (rooms: Room[], adjustments: string[]) => void;
  onCancel?: () => void;
  cancelLabel?: string;
  /** What accepting this drawing leads to - another storey, or the build. */
  cta?: string;
  /** A complaint from whoever received the rooms, shown where the board's own go. */
  notice?: string | null;
  busy?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const [tool, setTool] = useState<Tool>("draw");
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [naming, setNaming] = useState<{ polygon: Vec2[]; at: Vec2 } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [problem, setProblem] = useState<{ why: string; at: Vec2[] } | null>(null);

  const drawing = useRef<Stroke | null>(null);
  const panning = useRef<{ x: number; y: number } | null>(null);
  const spaceDown = useRef(false);

  /**
   * The spaces, recomputed whenever the walls change.
   *
   * The same function the reader uses, so what is on screen and what will be
   * accepted cannot disagree. It only runs when a stroke lands - never during
   * one - so the cost is one pass per wall drawn.
   */
  const read = useMemo(() => readStrokes(strokes), [strokes]);
  const faces = read.faces;

  /** The name written inside a space, if any. */
  const nameOf = useCallback(
    (polygon: Vec2[]): Label | null =>
      labels.find((l) => pointInPolygon([l.x, l.y], polygon)) ?? null,
    [labels],
  );

  const named = useMemo(() => faces.filter((f) => nameOf(f) !== null).length, [faces, nameOf]);
  const taken = useMemo(
    () => new Set(labels.map((l) => l.text.trim().toLowerCase())),
    [labels],
  );

  /**
   * The roads in paper pixels, beside the outline and in the same units.
   *
   * Kept as one polyline per way, because a road is split at every junction and
   * joining the pieces would draw a line straight across whatever lies between
   * them. Labelled once per street, on its longest piece, for the same reason
   * the fetch groups by name: a road that arrives as five ways is one road.
   */
  const roadsPaper = useMemo(() => {
    if (!guide?.streets?.length) return [];
    const mpp = guide.metresPerPixel;

    // The middle of the building, which is what "near" is measured from.
    const outline = guide.outline.map(([x, y]) => [x / mpp, y / mpp] as Vec2);
    const hx = outline.reduce((sum, q) => sum + q[0], 0) / Math.max(outline.length, 1);
    const hy = outline.reduce((sum, q) => sum + q[1], 0) / Math.max(outline.length, 1);

    return guide.streets.map((street) => {
      const ways = street.ways.map((way) => way.map(([x, y]) => [x / mpp, y / mpp] as Vec2));

      /**
       * The name goes where the road passes the house.
       *
       * Not at the middle of the road, which was the obvious choice and put
       * every name off the edge of the paper: a street runs for a block and the
       * pad shows a house. The point nearest the building is the one somebody
       * is looking at when they ask which way they are facing, and it is on
       * screen by construction.
       */
      let at: { point: Vec2; along: Vec2; away: number } | null = null;
      for (const way of ways) {
        for (let i = 1; i < way.length; i++) {
          const a = way[i - 1];
          const b = way[i];
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const len2 = dx * dx + dy * dy;
          const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((hx - a[0]) * dx + (hy - a[1]) * dy) / len2));
          const point: Vec2 = [a[0] + dx * t, a[1] + dy * t];
          const away = Math.hypot(point[0] - hx, point[1] - hy);
          if (!at || away < at.away) at = { point, along: [dx, dy], away };
        }
      }
      return { name: street.name, ways, at };
    });
  }, [guide]);

  /** The outline in the pad's own pixels, which is what everything is drawn in. */
  const guidePaper = useMemo(
    () =>
      guide
        ? guide.outline.map(
            ([x, y]) => [x / guide.metresPerPixel, y / guide.metresPerPixel] as Vec2,
          )
        : null,
    [guide],
  );

  /** Screen to paper. Everything stored is in paper coordinates. */
  const toPaper = useCallback(
    (clientX: number, clientY: number): [number, number] => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return [0, 0];
      return [
        (clientX - rect.left - view.x) / view.scale,
        (clientY - rect.top - view.y) / view.scale,
      ];
    },
    [view],
  );

  /** Paper to screen, for putting the naming card beside the room it names. */
  const toScreen = useCallback(
    ([x, y]: Vec2): [number, number] => [x * view.scale + view.x, y * view.scale + view.y],
    [view],
  );

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);

    // Graph paper, faint enough that it cannot be mistaken for a wall.
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1 / view.scale;
    const step = 40;
    const from = -2000;
    const to = 4000;
    ctx.beginPath();
    for (let x = from; x <= to; x += step) {
      ctx.moveTo(x, from);
      ctx.lineTo(x, to);
    }
    for (let y = from; y <= to; y += step) {
      ctx.moveTo(from, y);
      ctx.lineTo(to, y);
    }
    ctx.stroke();

    /**
     * The streets, under the building and under everything else.
     *
     * The pad showed the shape of the building and nothing about where it sat,
     * so "which of these walls faces the road" was not a question it could
     * answer - and getting it wrong stayed invisible until the plan was on the
     * satellite photograph two steps later. The outline was squared up on its
     * dominant wall, so these arrive at their true angle *to the building*,
     * which is the thing worth reading.
     */
    for (const road of roadsPaper) {
      ctx.strokeStyle = ROAD;
      ctx.lineWidth = 7 / view.scale;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const way of road.ways) {
        if (way.length < 2) continue;
        ctx.beginPath();
        way.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.stroke();
      }

      // The name, turned to lie along the road and always the right way up -
      // a street name read upside down is worse than no street name.
      if (!road.at) continue;
      let angle = Math.atan2(road.at.along[1], road.at.along[0]);
      if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;

      ctx.save();
      ctx.translate(road.at.point[0], road.at.point[1]);
      ctx.rotate(angle);
      ctx.fillStyle = ROAD_NAME;
      ctx.font = `600 ${13 / view.scale}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(road.name, 0, -10 / view.scale);
      ctx.restore();
    }
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";

    // The building, under everything. A shape to trace, never a thing to hit -
    // it is the constraint rather than part of the drawing.
    if (guidePaper && guidePaper.length > 2) {
      ctx.beginPath();
      guidePaper.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = GUIDE_FILL;
      ctx.fill();
      ctx.strokeStyle = GUIDE_EDGE;
      ctx.lineWidth = 2 / view.scale;
      ctx.setLineDash([10 / view.scale, 7 / view.scale]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // The spaces, under the ink so a wall is never hidden by the room it makes.
    faces.forEach((face, i) => {
      const has = nameOf(face) !== null;
      ctx.beginPath();
      face.forEach(([x, y], j) => (j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = i === hover ? HOVER_FILL : has ? NAMED_FILL : EMPTY_FILL;
      ctx.fill();
      // Every space is outlined, not only the hovered one, so the shape of what
      // was found is legible without hunting for it with the pointer.
      ctx.strokeStyle = i === hover ? HOVER_EDGE : has ? NAMED_EDGE : EMPTY_EDGE;
      ctx.lineWidth = (i === hover ? 2.5 : 1.5) / view.scale;
      ctx.stroke();
    });

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of [...strokes, drawing.current].filter(Boolean) as Stroke[]) {
      ctx.strokeStyle = stroke.erase ? PAPER : INK;
      ctx.lineWidth = stroke.width;
      ctx.beginPath();
      stroke.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();
    }

    ctx.fillStyle = INK;
    ctx.font = "600 20px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    for (const label of labels) ctx.fillText(label.text, label.x, label.y);

    // Wherever the reading refused, ringed so it can be found.
    if (problem) {
      ctx.strokeStyle = "#f2a541";
      ctx.lineWidth = 3 / view.scale;
      for (const [x, y] of problem.at) {
        ctx.beginPath();
        ctx.arc(x, y, 22, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }, [strokes, labels, faces, guidePaper, roadsPaper, hover, nameOf, view, problem]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const fit = () => {
      canvas.width = wrap.clientWidth;
      canvas.height = wrap.clientHeight;
      redraw();
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [redraw]);

  useEffect(redraw, [redraw]);

  /**
   * Open on the building, once.
   *
   * The pad's coordinates are metres over a fixed scale now, so an outline can
   * land anywhere and at any size relative to the canvas - a wide bungalow and
   * a narrow townhouse are not the same shape on screen. Framing it on arrival
   * is the difference between "trace this" and "find the building first".
   *
   * Only on arrival: re-framing on every resize would fight anybody who has
   * panned or zoomed, and a pad that keeps snapping back is worse than one that
   * opens badly.
   */
  const framed = useRef(false);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (framed.current || !guidePaper || guidePaper.length < 3 || !canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width < 40 || height < 40) return;

    const xs = guidePaper.map((p) => p[0]);
    const ys = guidePaper.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    if (w <= 0 || h <= 0) return;

    /**
     * Room round the building for the streets, and not a metre more.
     *
     * The pad opened framed exactly on the outline, which put every road
     * comfortably off the edge of the paper - so the streets were fetched,
     * projected, drawn, and never seen. Framing on the roads instead would fix
     * that and ruin the thing the pad is for: the building would be a stamp in
     * the middle of a street map, and walls are drawn on the building.
     *
     * So the building still decides the scale and simply keeps less of the
     * paper. At this margin a house sits large enough to draw on with the road
     * it faces in view, which is all the orientation anybody needs.
     */
    const margin = roadsPaper.length > 0 ? 0.55 : 0.8;
    const scale = Math.max(0.3, Math.min(4, Math.min(width / w, height / h) * margin));
    framed.current = true;
    setView({
      scale,
      x: width / 2 - ((Math.min(...xs) + w / 2) * scale),
      y: height / 2 - ((Math.min(...ys) + h / 2) * scale),
    });
  }, [guidePaper, roadsPaper, strokes]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDown.current = true;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDown.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  });

  /**
   * One timeline for strokes and labels alike.
   *
   * The old undo popped a label only when there were no strokes at all, so
   * after drawing four walls and naming two rooms it chewed backwards through
   * the walls and never touched the names.
   */
  const history = useRef<Array<{ strokes: Stroke[]; labels: Label[] }>>([]);
  const remember = () => {
    history.current.push({ strokes, labels });
    if (history.current.length > 80) history.current.shift();
  };
  const undo = () => {
    const previous = history.current.pop();
    if (!previous) return;
    onStrokes(previous.strokes);
    onLabels(previous.labels);
    setNaming(null);
    setProblem(null);
  };

  /**
   * Turn the whole drawing, strokes and names together.
   *
   * The building outline and the streets stay put: those are survey data, and
   * the thing that might be ninety degrees out is the drawing. Somebody who
   * starts at the top of the paper and works down has drawn a perfectly good
   * plan of a house facing the wrong way, and until now the only way to find
   * out was to reach the satellite step and see it sitting sideways on the map.
   *
   * About the drawing's own middle, so it turns where it is rather than
   * swinging away across the paper. One entry on the undo timeline - it is a
   * single thing somebody did, and taking it back a wall at a time would be
   * absurd.
   */
  const turn = (degrees: number) => {
    if (strokes.length === 0 && labels.length === 0) return;
    const points = [
      ...strokes.flatMap((stroke) => stroke.points),
      ...labels.map((l) => [l.x, l.y] as [number, number]),
    ];
    const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
    const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;

    // The same sign convention as `rotate` in `footprint.ts`, which the plan
    // frame also follows - a disagreement here would turn the drawing the
    // opposite way to the building it is being lined up with.
    const r = (-degrees * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const about = ([x, y]: [number, number]): [number, number] => {
      const dx = x - cx;
      const dy = y - cy;
      return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
    };

    remember();
    setProblem(null);
    setNaming(null);
    onStrokes((all) => all.map((stroke) => ({ ...stroke, points: stroke.points.map(about) })));
    onLabels((all) =>
      all.map((label) => {
        const [x, y] = about([label.x, label.y]);
        return { ...label, x, y };
      }),
    );
  };

  /** Which space a paper point is in, or null out in the margins. */
  const faceAt = useCallback(
    (point: Vec2): number | null => {
      const hit = faces.findIndex((face) => pointInPolygon(point, face));
      return hit >= 0 ? hit : null;
    },
    [faces],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (busy) return;
    (e.target as Element).setPointerCapture(e.pointerId);

    if (e.button === 1 || spaceDown.current) {
      panning.current = { x: e.clientX - view.x, y: e.clientY - view.y };
      return;
    }
    if (tool === "name") {
      const at = toPaper(e.clientX, e.clientY);
      const hit = faceAt(at);
      // A click in the margins names nothing. It used to drop a label there and
      // refuse later; saying so now is the same information, sooner.
      if (hit === null) {
        setNaming(null);
        setProblem({
          why: "That is not inside a room. Click a shaded space, or close its walls first.",
          at: [],
        });
        return;
      }
      setProblem(null);
      setNaming({ polygon: faces[hit], at: centroid(faces[hit]) });
      return;
    }
    remember();
    const [x, y] = toPaper(e.clientX, e.clientY);
    drawing.current = {
      points: [[x, y]],
      width: tool === "erase" ? ERASER_PX : PEN_PX,
      erase: tool === "erase",
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (panning.current) {
      setView((v) => ({ ...v, x: e.clientX - panning.current!.x, y: e.clientY - panning.current!.y }));
      return;
    }
    if (drawing.current) {
      drawing.current.points.push(toPaper(e.clientX, e.clientY));
      redraw();
      return;
    }
    // Only the name tool lights a room. Under the pen it would be a distraction
    // from the line being drawn.
    if (tool !== "name") {
      if (hover !== null) setHover(null);
      return;
    }
    const next = faceAt(toPaper(e.clientX, e.clientY));
    if (next !== hover) setHover(next);
  };

  const onPointerUp = () => {
    panning.current = null;
    const stroke = drawing.current;
    drawing.current = null;
    if (!stroke || stroke.points.length < 2) return;
    onStrokes((all) => [...all, stroke]);
    setProblem(null);
  };

  /** Put a name in the space the card is open on, replacing whatever was there. */
  /**
   * Any change to the names answers whatever the last read complained about.
   *
   * It was cleared when a stroke landed and when the pad was cleared, but not
   * when a room was named - so "6 spaces have no name" sat there while somebody
   * named all six, and the only way to find out they had finished was to press
   * the button again.
   */
  const nameIt = (text: string) => {
    const trimmed = text.trim();
    if (!naming || !trimmed) {
      setNaming(null);
      return;
    }
    const polygon = naming.polygon;
    remember();
    setProblem(null);
    onLabels((all) => [
      ...all.filter((l) => !pointInPolygon([l.x, l.y], polygon)),
      { x: naming.at[0], y: naming.at[1], text: trimmed },
    ]);
    setNaming(null);
  };

  const unname = () => {
    if (!naming) return;
    const polygon = naming.polygon;
    remember();
    setProblem(null);
    onLabels((all) => all.filter((l) => !pointInPolygon([l.x, l.y], polygon)));
    setNaming(null);
  };

  const finish = () => {
    const result = strokesToRooms(strokes, labels, {
      metresPerPixel: guide?.metresPerPixel,
      targetGroundSqft,
    });
    if (!result.ok) {
      setProblem({ why: result.why, at: result.at });
      return;
    }
    setProblem(null);
    onRooms(result.rooms, result.adjustments);
  };

  const button = (on: boolean) =>
    `min-h-11 rounded-lg border px-3 py-2 text-xs transition ${
      on
        ? "border-accent bg-accent text-ink-900"
        : "border-ink-500 bg-ink-800 text-mist-200 hover:bg-ink-700"
    }`;

  const existing = naming ? nameOf(naming.polygon) : null;
  /**
   * Beside the room, never on top of it.
   *
   * The card used to be pinned to the top of the canvas, which covered the
   * drawing and said nothing about which space had been hit. Putting it at the
   * room's centroid would say which one and then hide it - and seeing the room
   * lit is the whole reason this is better. So it stands clear of the room's
   * right edge, flips to the left when that would run off the canvas, and is
   * clamped into view either way.
   */
  const card = useMemo(() => {
    if (!naming) return null;
    const xs = naming.polygon.map((p) => p[0]);
    const ys = naming.polygon.map((p) => p[1]);
    const [right, top] = toScreen([Math.max(...xs), Math.min(...ys)]);
    const [left] = toScreen([Math.min(...xs), 0]);
    const width = wrapRef.current?.clientWidth ?? 0;
    const beyond = right + CARD_GAP_PX + CARD_WIDTH_PX > width;
    return { x: beyond ? left - CARD_GAP_PX - CARD_WIDTH_PX : right + CARD_GAP_PX, y: top };
  }, [naming, toScreen]);
  const missing = wanted.filter((label) => !taken.has(label.trim().toLowerCase()));

  /** The guide's screen rectangle, recomputed as the view moves. */
  const guideBox = useMemo(() => {
    if (!guidePaper || guidePaper.length < 3) return null;
    const corners = guidePaper.map(toScreen);
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
  }, [guidePaper, toScreen]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setTool("draw")} className={button(tool === "draw")}>
          Draw walls
        </button>
        <button
          type="button"
          onClick={() => {
            setTool("name");
            setNaming(null);
          }}
          className={button(tool === "name")}
        >
          Name a room
        </button>
        <button
          type="button"
          onClick={() => {
            setTool("erase");
            setNaming(null);
          }}
          className={button(tool === "erase")}
        >
          Erase
        </button>
        <span className="mx-1 h-6 w-px bg-ink-600" />
        {/* Ninety degrees covers a house drawn sideways, which is the whole of
            the real case. The building outline does not move: it is the survey,
            and the drawing is the thing being lined up with it. */}
        <button
          type="button"
          onClick={() => turn(-90)}
          title="Turn the drawing a quarter turn anticlockwise"
          data-testid="rotate-left"
          className={button(false)}
        >
          ↺ Turn
        </button>
        <button
          type="button"
          onClick={() => turn(90)}
          title="Turn the drawing a quarter turn clockwise"
          data-testid="rotate-right"
          className={button(false)}
        >
          ↻ Turn
        </button>
        <button type="button" onClick={undo} className={button(false)}>
          Undo
        </button>
        <button
          type="button"
          onClick={() => {
            remember();
            onStrokes([]);
            onLabels([]);
            setNaming(null);
            setProblem(null);
          }}
          className={button(false)}
        >
          Clear
        </button>
        <span className="ml-auto text-[12px] text-mist-400">
          Space or middle-drag to move · scroll to zoom
        </span>
      </div>

      <div
        ref={wrapRef}
        className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-ink-600"
      >
        <canvas
          ref={canvasRef}
          data-testid="drawing-board"
          /**
           * Where the building sits on screen, in canvas pixels.
           *
           * For the suites, which otherwise draw at fixed fractions of the
           * canvas and so draw a different house every time the framing
           * changes - a real person draws inside the dashed shape because they
           * can see it, and this is how a test does the same thing.
           */
          data-guide={
            guideBox
              ? `${Math.round(guideBox.x)},${Math.round(guideBox.y)},${Math.round(guideBox.w)},${Math.round(guideBox.h)}`
              : undefined
          }
          className="block h-full w-full touch-none"
          style={{ cursor: tool === "name" ? (hover === null ? "default" : "pointer") : "crosshair" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => {
            onPointerUp();
            setHover(null);
          }}
          onWheel={(e) => {
            const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
            setView((v) => ({ ...v, scale: Math.max(0.3, Math.min(4, v.scale * factor)) }));
          }}
        />

        {naming && card && (
          <div
            data-testid="naming-card"
            className="absolute z-10 max-w-[calc(100%-1rem)] rounded-lg border border-ink-500 bg-ink-800 p-2.5 shadow-lg"
            /* Beside the room being named rather than pinned to the top of the
               canvas, where it covered the drawing and told you nothing about
               which space you had hit. Clamped so it stays on screen. */
            style={{
              width: CARD_WIDTH_PX,
              left: `clamp(0.5rem, ${card.x}px, calc(100% - ${CARD_WIDTH_PX + 8}px))`,
              top: `clamp(0.5rem, ${card.y}px, calc(100% - 13rem))`,
            }}
          >
            {existing && (
              <p className="mb-1.5 text-[11px] text-mist-400">
                This space is <span className="text-mist-200">{existing.text}</span>. Naming it
                again renames it — if it should be two rooms, draw the wall between them.
              </p>
            )}
            {missing.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {missing.map((label) => (
                  <button
                    key={label}
                    type="button"
                    data-testid="name-chip"
                    onClick={() => nameIt(label)}
                    className="rounded border border-ink-500 px-2 py-1 text-xs text-mist-200 transition hover:border-accent-dim hover:bg-ink-700"
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const input = e.currentTarget.elements.namedItem("room") as HTMLInputElement;
                nameIt(input.value);
              }}
            >
              <input
                name="room"
                autoFocus
                defaultValue={existing?.text ?? ""}
                placeholder="Something else"
                aria-label="Room name"
                className="h-9 min-w-0 flex-1 rounded border border-ink-600 bg-ink-700 px-2.5 text-sm outline-none focus:border-accent-dim"
              />
              <button
                type="submit"
                className="rounded bg-accent px-3 py-2 text-xs font-semibold text-ink-900"
              >
                Add
              </button>
            </form>
            <div className="mt-1.5 flex items-center gap-3 text-[11px]">
              {existing && (
                <button type="button" onClick={unname} className="text-warn hover:underline">
                  Remove name
                </button>
              )}
              <button
                type="button"
                onClick={() => setNaming(null)}
                className="ml-auto text-mist-400 hover:text-mist-200"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>

      {(problem || notice) && (
        <p
          data-testid="drawing-problem"
          className="mt-2 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
        >
          {problem?.why ?? notice}
        </p>
      )}

      {/* What the sheet says the house has, against what has actually been
          drawn. A room nobody drew has to be visibly dropped rather than
          quietly invented later, because the sheet is what decides the room
          list the whole build is packed from. */}
      {wanted.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] uppercase tracking-wide text-mist-400">
            In the house
          </span>
          {wanted.map((label) => {
            const on = taken.has(label.trim().toLowerCase());
            return (
              <span
                key={label}
                data-room={label}
                data-testid={on ? "wanted-drawn" : "wanted-missing"}
                className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs ${
                  on
                    ? "border-accent-dim bg-accent/10 text-mist-200"
                    : "border-ink-600 text-mist-400"
                }`}
              >
                {on ? "✓" : "·"} {label}
                {!on && onDropWanted && (
                  <button
                    type="button"
                    onClick={() => onDropWanted(label)}
                    aria-label={`Take ${label} out of the house`}
                    className="ml-0.5 text-mist-400 hover:text-warn"
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={finish}
          disabled={busy || strokes.length < 3}
          data-testid="read-drawing"
          className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-ink-900 transition hover:brightness-110 disabled:opacity-40"
        >
          {cta}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-ink-500 px-4 py-2.5 text-sm text-mist-200 transition hover:bg-ink-600"
          >
            {cancelLabel}
          </button>
        )}
        {/* What the build will do, said before it is done rather than after.
            A space with no name is not an error any more - it goes to the room
            next door - so saying "still to name" would be asking for work that
            is not needed. It says what will happen to it instead. */}
        <span data-testid="drawing-status" className="text-xs text-mist-400">
          {faces.length === 0
            ? "Draw the walls — a space lights up as soon as the walls close round it."
            : `${named} of ${faces.length} named` +
              (faces.length > named
                ? ` · ${faces.length - named} unnamed, ${
                    named > 0 ? "which will join the room next door" : "so name one to start"
                  }`
                : missing.length > 0
                  ? ` · ${missing.length} not drawn`
                  : " · ready")}
        </span>
      </div>
    </div>
  );
}
