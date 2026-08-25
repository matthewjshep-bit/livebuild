"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Draw the floor plan here, with a mouse, trackpad or finger.
 *
 * The first version of this feature only accepted a photograph of paper, which
 * is a real obstacle: it needs paper, a pen, and a phone, and it assumes you are
 * not already sitting at the machine you are building the tour on. Drawing
 * directly is the same idea without the detour.
 *
 * The reading pipeline is unchanged - the canvas is exported as an image and
 * sent to the same endpoint - so a drawing made here and a photo of a notepad
 * are treated identically.
 */

const WIDTH = 1400;
const HEIGHT = 1000;
const INK = "#262a37";
const PAPER = "#faf8f2";

type Stroke = { points: Array<[number, number]>; width: number; erase: boolean };
type Label = { x: number; y: number; text: string };
type Tool = "pen" | "text" | "erase";

export function SketchPad({
  busy,
  onRead,
}: {
  busy: boolean;
  onRead: (dataUrl: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [tool, setTool] = useState<Tool>("pen");
  const [typing, setTyping] = useState<{ x: number; y: number; text: string } | null>(null);
  const drawing = useRef<Stroke | null>(null);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // A faint grid, purely to help keep walls straight. It is drawn far too
    // lightly to be mistaken for content when the drawing is read back.
    ctx.strokeStyle = "rgba(120,130,150,0.13)";
    ctx.lineWidth = 1;
    for (let x = 50; x < WIDTH; x += 50) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, HEIGHT);
      ctx.stroke();
    }
    for (let y = 50; y < HEIGHT; y += 50) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(WIDTH, y);
      ctx.stroke();
    }

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of [...strokes, drawing.current].filter(Boolean) as Stroke[]) {
      ctx.strokeStyle = stroke.erase ? PAPER : INK;
      ctx.lineWidth = stroke.width;
      ctx.beginPath();
      stroke.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      // A single tap should still leave a mark.
      if (stroke.points.length === 1) ctx.lineTo(stroke.points[0][0] + 0.1, stroke.points[0][1]);
      ctx.stroke();
    }

    ctx.fillStyle = INK;
    ctx.font = "34px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    for (const label of labels) ctx.fillText(label.text, label.x, label.y);
  }, [strokes, labels]);

  useEffect(redraw, [redraw]);

  const toCanvas = (e: React.PointerEvent): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [
      ((e.clientX - rect.left) / rect.width) * WIDTH,
      ((e.clientY - rect.top) / rect.height) * HEIGHT,
    ];
  };

  /**
   * The label box opens on click, not on pointer-down.
   *
   * Opening it on pointer-down looked fine and never worked: the input mounts
   * with autofocus mid-gesture, then the same click's pointer-up moves focus
   * away, `onBlur` fires with the field still empty, and the box vanishes
   * before a key can be pressed. Waiting for the click to finish leaves focus
   * where it belongs.
   */
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool !== "text") return;
    const rect = e.currentTarget.getBoundingClientRect();
    setTyping({
      x: ((e.clientX - rect.left) / rect.width) * WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * HEIGHT,
      text: "",
    });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool === "text") return;
    const point = toCanvas(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = {
      points: [point],
      width: tool === "erase" ? 40 : 5,
      erase: tool === "erase",
    };
    redraw();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current.points.push(toCanvas(e));
    redraw();
  };

  const onPointerUp = () => {
    if (!drawing.current) return;
    const finished = drawing.current;
    drawing.current = null;
    setStrokes((current) => [...current, finished]);
  };

  const undo = () => {
    // Labels and strokes share one timeline in the user's head, so undo removes
    // whichever was added last rather than always a stroke.
    if (labels.length > 0 && strokes.length === 0) {
      setLabels((c) => c.slice(0, -1));
      return;
    }
    setStrokes((c) => c.slice(0, -1));
  };

  const commitLabel = () => {
    if (typing && typing.text.trim()) {
      setLabels((c) => [...c, { x: typing.x, y: typing.y, text: typing.text.trim() }]);
    }
    setTyping(null);
  };

  const isEmpty = strokes.length === 0 && labels.length === 0;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {(
          [
            ["pen", "Draw walls"],
            ["text", "Add a name"],
            ["erase", "Erase"],
          ] as Array<[Tool, string]>
        ).map(([key, title]) => (
          <button
            key={key}
            onClick={() => setTool(key)}
            className={`rounded px-3 py-1.5 text-xs transition ${
              tool === key
                ? "bg-accent text-ink-900"
                : "border border-ink-500 text-mist-200 hover:bg-ink-600"
            }`}
          >
            {title}
          </button>
        ))}
        <button
          onClick={undo}
          disabled={isEmpty}
          className="rounded border border-ink-500 px-3 py-1.5 text-xs disabled:opacity-30"
        >
          Undo
        </button>
        <button
          onClick={() => {
            setStrokes([]);
            setLabels([]);
          }}
          disabled={isEmpty}
          className="rounded border border-ink-500 px-3 py-1.5 text-xs disabled:opacity-30"
        >
          Clear
        </button>
        <span className="ml-auto text-[11px] text-mist-400">
          {tool === "text"
            ? "Click inside a room, then type its name"
            : tool === "erase"
              ? "Drag over anything to remove it"
              : "Drag to draw walls — a box per room"}
        </span>
      </div>

      <div className="relative">
        <canvas
          ref={canvasRef}
          width={WIDTH}
          height={HEIGHT}
          onClick={onClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          className="w-full touch-none rounded-lg border border-ink-500"
          style={{ aspectRatio: `${WIDTH} / ${HEIGHT}`, cursor: tool === "text" ? "text" : "crosshair" }}
        />

        {typing && (
          <input
            autoFocus
            value={typing.text}
            onChange={(e) => setTyping({ ...typing, text: e.target.value })}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitLabel();
              if (e.key === "Escape") setTyping(null);
            }}
            placeholder="Room name"
            className="absolute z-10 w-40 -translate-x-1/2 rounded border border-accent bg-ink-900 px-2 py-1 text-sm outline-none"
            style={{
              left: `${(typing.x / WIDTH) * 100}%`,
              top: `${(typing.y / HEIGHT) * 100}%`,
            }}
          />
        )}

        {isEmpty && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="text-center text-ink-600">
              <div className="text-4xl">✏️</div>
              <p className="mt-1 text-sm">Draw a box for each room</p>
              <p className="text-xs">then switch to &ldquo;Add a name&rdquo; and label them</p>
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() => {
            const canvas = canvasRef.current;
            if (canvas) onRead(canvas.toDataURL("image/jpeg", 0.9));
          }}
          disabled={busy || labels.length === 0}
          className="rounded bg-accent px-4 py-2 text-xs font-medium text-ink-900 disabled:opacity-35"
        >
          {busy ? "Reading your drawing…" : "Build this layout"}
        </button>
        <span className="text-[11px] text-mist-400">
          {labels.length === 0
            ? "Name at least one room first — the names are how rooms are identified"
            : `${labels.length} room${labels.length === 1 ? "" : "s"} named. Write a size like 12x14 in a room to set the scale.`}
        </span>
      </div>
    </div>
  );
}
