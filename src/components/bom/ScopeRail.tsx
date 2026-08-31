"use client";

import { BomPane } from "@/components/bom/BomPane";
import { BomTree } from "@/components/bom/BomTree";
import type { Bom } from "@/lib/bom/build";
import type { Element, Grade } from "@/lib/bom/condition";
import { type Pick, roomScope } from "@/lib/bom/pickable";

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
  focusRoomId = null,
  onClearFocus,
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
  /** One room, costed on its own, or null for the whole house. */
  focusRoomId?: string | null;
  onClearFocus?: () => void;
}) {
  /**
   * One room's scope, and nothing of the house's.
   *
   * Every figure below comes from here rather than from `bom` when a room is
   * focused. That is the whole point and also the whole risk: `bom.total`
   * includes the roof, the systems and the exterior, so a room headed by it
   * would be overstated by the price of a re-roof - and it would look entirely
   * plausible, because it is a real number about a real house.
   */
  const scope = roomScope(bom, focusRoomId);
  const headline = scope ? scope.total : bom.total;
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
          {money(headline)}
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
          <div className="text-[10px] uppercase tracking-wide text-mist-400">
            {scope ? scope.room.label : "Scope of work"}
          </div>
          <div
            className="text-lg font-semibold tabular-nums text-mist-200"
            data-rail-total
            data-room={scope ? scope.room.roomId : undefined}
          >
            {money(headline)}
          </div>
          {scope ? (
            <div className="mt-0.5 text-[11px] leading-relaxed text-mist-400">
              {scope.lineCount === 0
                ? "Nothing needed in this room."
                : `${scope.lineCount} line${scope.lineCount === 1 ? "" : "s"} · ${money(scope.material)} material · ${money(scope.labour)} labour`}
              {/* Said rather than silently missing. Windows are counted room by
                  room and then priced once for the whole building, because a
                  glazing job is quoted for a house and not for a bedroom - so
                  this figure genuinely excludes them, and a reader who was not
                  told would assume otherwise. */}
              {scope.windowCount > 0 && (
                <>
                  {" · "}
                  {scope.windowCount} window{scope.windowCount === 1 ? "" : "s"}, priced across
                  the house
                </>
              )}
            </div>
          ) : (
            <div className="mt-0.5 text-[11px] leading-relaxed text-mist-400">
              {bom.sanity.summary}
            </div>
          )}
          {scope && onClearFocus && (
            <button
              onClick={onClearFocus}
              data-whole-house
              className="mt-1 text-[11px] text-mist-400 underline underline-offset-4 hover:text-mist-200"
            >
              &larr; Whole house
            </button>
          )}
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
          onlyRoomId={focusRoomId}
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
