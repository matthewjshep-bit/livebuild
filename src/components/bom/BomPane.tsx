"use client";

import type { Bom } from "@/lib/bom/build";
import {
  GRADES,
  GRADE_HELP,
  GRADE_LABEL,
  type Element,
  type Grade,
} from "@/lib/bom/condition";
import { ELEMENT_LABEL, type Pick, detailFor } from "@/lib/bom/pickable";

/**
 * What the thing you are looking at costs.
 *
 * The scope page answers "what does this house need" and this answers "what
 * about *that*" - which is the question people actually ask while walking a
 * property. Standing in a bedroom, its scope; clicking a bath, that bath.
 *
 * The condition control is here rather than only on the scope page because the
 * judgement happens at the point of looking. You see a tired worktop, mark it
 * dated, and watch the total move. Making someone leave, find a list and come
 * back is how a tool stops being used.
 */

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function BomPane({
  bom,
  pick,
  condition,
  onGrade,
  onClear,
  onOpenFull,
}: {
  bom: Bom;
  pick: Pick | null;
  /** Current grades for the picked room, so the control reflects reality. */
  condition: Partial<Record<Element, Grade>>;
  onGrade: (roomId: string, element: Element, grade: Grade) => void;
  onClear: () => void;
  onOpenFull: () => void;
}) {
  const detail = detailFor(bom, pick);
  if (!detail || !pick) return null;

  const { room, element, lines, total, nothingNeeded } = detail;
  const grade = element ? condition[element] : undefined;

  return (
    <div
      data-scope-pane
      data-heading={element ? ELEMENT_LABEL[element] : room.label}
      data-total={Math.round(total)}
      className="absolute top-3 left-3 z-10 w-72 overflow-hidden rounded-lg border border-ink-600 bg-ink-800/95 backdrop-blur"
    >
      <div className="flex items-start justify-between gap-2 border-b border-ink-700 px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-mist-200">
            {element ? ELEMENT_LABEL[element] : room.label}
          </div>
          <div className="text-[11px] text-mist-400">
            {element ? room.label : `${Math.round(room.takeoff.floorSqft)} sqft`}
            {" · "}
            {element ? "this item" : `${lines.length} item${lines.length === 1 ? "" : "s"}`}
          </div>
        </div>
        <button
          onClick={onClear}
          className="shrink-0 text-xs text-mist-400 hover:text-mist-200"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {/* Grade it here, where the judgement is actually being made. */}
      {element && (
        <div className="border-b border-ink-700 px-3 py-2.5">
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-wide text-mist-400">
              Condition
            </span>
            <select
              value={grade ?? "not_visible"}
              aria-label={`${ELEMENT_LABEL[element]} condition`}
              onChange={(e) => onGrade(room.roomId, element, e.target.value as Grade)}
              className="w-full rounded border border-ink-600 bg-ink-700 px-2 py-1 text-xs outline-none focus:border-accent-dim"
            >
              {GRADES.map((g) => (
                <option key={g} value={g}>
                  {GRADE_LABEL[g]}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-1 text-[10px] leading-relaxed text-mist-400">
            {GRADE_HELP[(grade ?? "not_visible") as Grade]}
          </p>
        </div>
      )}

      <div className="max-h-64 overflow-y-auto">
        {nothingNeeded ? (
          <p className="px-3 py-4 text-center text-xs text-mist-400">
            {element ? "Nothing needed here." : "This room needs nothing."}
          </p>
        ) : (
          lines.map((line) => (
            <div key={line.id} className="border-b border-ink-700/60 px-3 py-2 last:border-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-xs text-mist-200">{line.label}</span>
                <span className="shrink-0 text-xs tabular-nums text-mist-200">
                  {money(line.total)}
                </span>
              </div>
              <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[10px] text-mist-400">
                <span>
                  {line.quantity.toLocaleString("en-US", { maximumFractionDigits: 1 })} {line.unit}
                  {line.unit !== "flat" && ` @ ${money(line.rate)}`}
                </span>
                <span>
                  {money(line.material)} mat · {money(line.labour)} lab
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-ink-600 px-3 py-2.5">
        <div>
          <div className="text-sm font-semibold tabular-nums text-mist-200">{money(total)}</div>
          {!element && room.unknownElements.length > 0 && (
            <div className="text-[10px] text-warn">
              {room.unknownElements.length} not seen
            </div>
          )}
        </div>
        <button
          onClick={onOpenFull}
          className="rounded border border-ink-500 px-2.5 py-1 text-[11px] hover:bg-ink-600"
        >
          Full scope
        </button>
      </div>
    </div>
  );
}
