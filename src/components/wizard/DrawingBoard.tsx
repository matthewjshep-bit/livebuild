"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { type Label, type Stroke, strokesToRooms } from "@/lib/plan/strokes";
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
 */

type Tool = "draw" | "name" | "erase";

const PEN_PX = 4;
const ERASER_PX = 34;

const PAPER = "#12151a";
const INK = "#c9d1da";
const GRID = "rgba(120,132,150,0.10)";

export function DrawingBoard({
  onRooms,
  onCancel,
  busy,
}: {
  /** The rooms read out of the drawing, in the drawing's own metres. */
  onRooms: (rooms: Room[], adjustments: string[]) => void;
  onCancel?: () => void;
  busy?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const [tool, setTool] = useState<Tool>("draw");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [naming, setNaming] = useState<{ x: number; y: number } | null>(null);
  const [problem, setProblem] = useState<{ why: string; at: Vec2[] } | null>(null);

  const drawing = useRef<Stroke | null>(null);
  const panning = useRef<{ x: number; y: number } | null>(null);
  const spaceDown = useRef(false);

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
  }, [strokes, labels, view, problem]);

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
    setStrokes(previous.strokes);
    setLabels(previous.labels);
    setProblem(null);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (busy) return;
    (e.target as Element).setPointerCapture(e.pointerId);

    if (e.button === 1 || spaceDown.current) {
      panning.current = { x: e.clientX - view.x, y: e.clientY - view.y };
      return;
    }
    if (tool === "name") {
      const [x, y] = toPaper(e.clientX, e.clientY);
      setNaming({ x, y });
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
    if (!drawing.current) return;
    drawing.current.points.push(toPaper(e.clientX, e.clientY));
    redraw();
  };

  const onPointerUp = () => {
    panning.current = null;
    const stroke = drawing.current;
    drawing.current = null;
    if (!stroke || stroke.points.length < 2) return;
    setStrokes((all) => [...all, stroke]);
    setProblem(null);
  };

  const read = () => {
    const result = strokesToRooms(strokes, labels);
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setTool("draw")} className={button(tool === "draw")}>
          Draw walls
        </button>
        <button type="button" onClick={() => setTool("name")} className={button(tool === "name")}>
          Name a room
        </button>
        <button type="button" onClick={() => setTool("erase")} className={button(tool === "erase")}>
          Erase
        </button>
        <span className="mx-1 h-6 w-px bg-ink-600" />
        <button type="button" onClick={undo} className={button(false)}>
          Undo
        </button>
        <button
          type="button"
          onClick={() => {
            remember();
            setStrokes([]);
            setLabels([]);
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
          className="block h-full w-full touch-none"
          style={{ cursor: tool === "name" ? "text" : "crosshair" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onWheel={(e) => {
            const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
            setView((v) => ({ ...v, scale: Math.max(0.3, Math.min(4, v.scale * factor)) }));
          }}
        />

        {naming && (
          <form
            className="absolute left-1/2 top-4 -translate-x-1/2 rounded-lg border border-ink-500 bg-ink-800 px-3 py-2 shadow-lg"
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.currentTarget.elements.namedItem("room") as HTMLInputElement);
              const text = input.value.trim();
              if (text) {
                remember();
                setLabels((all) => [...all, { ...naming, text }]);
              }
              setNaming(null);
            }}
          >
            <input
              name="room"
              autoFocus
              placeholder="Kitchen"
              aria-label="Room name"
              className="h-10 w-48 rounded border border-ink-600 bg-ink-700 px-2.5 text-sm outline-none focus:border-accent-dim"
            />
            <button type="submit" className="ml-2 rounded bg-accent px-3 py-2 text-xs font-semibold text-ink-900">
              Add
            </button>
          </form>
        )}
      </div>

      {problem && (
        <p
          data-testid="drawing-problem"
          className="mt-2 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
        >
          {problem.why}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={read}
          disabled={busy || strokes.length < 3}
          data-testid="read-drawing"
          className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-ink-900 transition hover:brightness-110 disabled:opacity-40"
        >
          Use this drawing
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-ink-500 px-4 py-2.5 text-sm text-mist-200 transition hover:bg-ink-600"
          >
            Cancel
          </button>
        )}
        <span className="text-xs text-mist-400">
          {labels.length === 0
            ? "Draw the walls, then name each room — the names are how the rest of the house knows what they are."
            : `${strokes.filter((s) => !s.erase).length} strokes, ${labels.length} named`}
        </span>
      </div>
    </div>
  );
}
