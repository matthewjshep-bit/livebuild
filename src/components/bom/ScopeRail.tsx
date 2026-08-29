"use client";

import { BomPane } from "@/components/bom/BomPane";
import { BomTree } from "@/components/bom/BomTree";
import type { Bom } from "@/lib/bom/build";
import type { Element, Grade } from "@/lib/bom/condition";
import type { Pick } from "@/lib/bom/pickable";

/**
 * The scope, on screen at all times.
 *
 * The bill of materials is the number this tool exists to produce, and until
 * now it appeared only after you clicked something - so the tour opened with no
 * costs visible anywhere. A rail is the honest place for it: a figure you have
 * to go and find is a figure nobody checks against what they are looking at.
 *
 * Three things stacked. The house total at the top, because that is the number
 * being asked for. The indented tree beneath it, which is the same component
 * the full scope page uses. And, when a fixture is selected rather than a whole
 * room, its own lines and its condition control pinned at the bottom - graded
 * where the judgement is actually being made.
 */

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function ScopeRail({
  bom,
  pick,
  condition,
  onGrade,
  onSelectRoom,
  onClear,
  onOpenFull,
  collapsed,
  onToggle,
}: {
  bom: Bom;
  pick: Pick | null;
  condition: Partial<Record<Element, Grade>>;
  onGrade: (roomId: string, element: Element, grade: Grade) => void;
  onSelectRoom: (roomId: string) => void;
  onClear: () => void;
  onOpenFull: () => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  // Collapsed it is a spine, not nothing: the total stays readable, because
  // that is the one figure worth 40px of a 3D view.
  if (collapsed) {
    return (
      <aside
        data-scope-rail
        data-collapsed="true"
        className="flex w-11 shrink-0 flex-col items-center gap-3 border-r border-ink-600 bg-ink-800 py-3"
      >
        <button
          onClick={onToggle}
          aria-label="Show the scope"
          className="rounded border border-ink-500 px-1.5 py-1 text-xs text-mist-200 hover:bg-ink-600"
        >
          ›
        </button>
        <div
          className="text-[10px] tabular-nums text-mist-400"
          style={{ writingMode: "vertical-rl" }}
        >
          {money(bom.total)}
        </div>
      </aside>
    );
  }

  return (
    <aside
      data-scope-rail
      className="flex w-80 shrink-0 flex-col border-r border-ink-600 bg-ink-800"
    >
      <div className="flex items-start justify-between gap-2 border-b border-ink-600 px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-mist-400">Scope of work</div>
          <div className="text-lg font-semibold tabular-nums text-mist-200" data-rail-total>
            {money(bom.total)}
          </div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-mist-400">
            {bom.sanity.summary}
          </div>
        </div>
        <button
          onClick={onToggle}
          aria-label="Hide the scope"
          className="shrink-0 rounded border border-ink-500 px-1.5 py-1 text-xs text-mist-400 hover:bg-ink-600"
        >
          ‹
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <BomTree
          bom={bom}
          compact
          selectedRoomId={pick?.roomId ?? null}
          onSelectRoom={onSelectRoom}
        />
      </div>

      {/* Shown for a whole room as well as for a fixture. Walking into a room
          asks "what does this room need", and answering only when a tap lands
          on a specific object would be answering a narrower question than the
          one being put. */}
      {pick && (
        <BomPane
          bom={bom}
          pick={pick}
          condition={condition}
          onGrade={onGrade}
          onClear={onClear}
          onOpenFull={onOpenFull}
          className="max-h-[45%] shrink-0 overflow-y-auto border-t border-ink-600 bg-ink-800"
        />
      )}

      {/* Only when the pane is not already offering it - the pane carries its
          own "Full scope" button. */}
      {!pick && (
        <button
          onClick={onOpenFull}
          className="shrink-0 border-t border-ink-600 px-3 py-2 text-[11px] text-mist-400 hover:bg-ink-700"
        >
          Open the full scope page →
        </button>
      )}
    </aside>
  );
}
