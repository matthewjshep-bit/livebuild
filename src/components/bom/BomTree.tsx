"use client";

import { useEffect, useRef, useState } from "react";

import type { Bom, BomAssembly, BomLine, BomRoom } from "@/lib/bom/build";
import { GRADE_LABEL, type Grade } from "@/lib/bom/condition";

/**
 * The indented bill of materials.
 *
 * House, room, assembly, line - the shape a PLM tool presents, and the shape a
 * contractor reads. Every level shows its own rollup, and every line shows the
 * quantity it came from and the condition that put it there, because a number
 * with no derivation behind it is not something anyone will trust enough to
 * bid against.
 */

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const GRADE_TONE: Record<Grade, string> = {
  good: "text-mist-400",
  fair: "text-mist-400",
  dated: "text-accent",
  poor: "text-warn",
  not_visible: "text-mist-400",
};

function Line({ line }: { line: BomLine }) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-3 py-1.5 pl-10 pr-3 text-xs hover:bg-ink-700/40">
      <div className="min-w-0">
        <span className="text-mist-200">{line.label}</span>
        <span className="ml-2 text-mist-400">
          {line.quantity.toLocaleString("en-US", { maximumFractionDigits: 1 })} {line.unit}
          {line.unit !== "flat" && ` @ ${money(line.rate)}`}
        </span>
        <span className={`ml-2 ${GRADE_TONE[line.because.grade]}`}>
          {line.because.element} {GRADE_LABEL[line.because.grade].toLowerCase()}
        </span>
        {line.assumed && (
          <span className="ml-2 rounded bg-ink-600 px-1.5 py-0.5 text-[10px] text-mist-400">
            assumed
          </span>
        )}
        {line.note && <div className="mt-0.5 text-[11px] text-mist-400">{line.note}</div>}
      </div>
      <div className="text-right tabular-nums">
        <div className="text-mist-200">{money(line.total)}</div>
        <div className="text-[10px] text-mist-400">
          {money(line.material)} mat · {money(line.labour)} lab
        </div>
      </div>
    </div>
  );
}

function Assembly({ assembly }: { assembly: BomAssembly }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="grid w-full grid-cols-[1fr_auto] gap-3 py-1.5 pl-6 pr-3 text-left text-xs hover:bg-ink-700/50"
      >
        <span className="text-mist-200">
          <span className="mr-1.5 inline-block w-3 text-mist-400">{open ? "▾" : "▸"}</span>
          {assembly.name}
          <span className="ml-2 text-mist-400">
            {assembly.lines.length} item{assembly.lines.length === 1 ? "" : "s"}
          </span>
        </span>
        <span className="tabular-nums text-mist-200">{money(assembly.total)}</span>
      </button>
      {open && assembly.lines.map((line) => <Line key={line.id} line={line} />)}
    </div>
  );
}

function Room({
  room,
  defaultOpen,
  compact,
  selected,
  onSelect,
}: {
  room: BomRoom;
  defaultOpen: boolean;
  compact: boolean;
  selected: boolean;
  onSelect?: (roomId: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const nothing = room.assemblies.length === 0;
  const ref = useRef<HTMLDivElement>(null);

  // Selecting a room in the model opens it here and scrolls it into view. The
  // rail is taller than it is tall, so a highlight alone would often be
  // highlighting something off-screen.
  useEffect(() => {
    if (!selected) return;
    if (!nothing) setOpen(true);
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected, nothing]);

  return (
    <div
      ref={ref}
      data-room-row={room.roomId}
      data-selected={selected ? "true" : undefined}
      className={`border-b border-ink-700 last:border-0 ${selected ? "bg-accent/10" : ""}`}
    >
      <button
        onClick={() => {
          onSelect?.(room.roomId);
          if (!nothing) setOpen((v) => !v);
        }}
        className={`grid w-full grid-cols-[1fr_auto] gap-3 px-3 py-2.5 text-left ${
          nothing && !onSelect ? "cursor-default" : "hover:bg-ink-700/60"
        }`}
      >
        <span className="min-w-0">
          <span className="text-sm font-medium text-mist-200">
            {!nothing && (
              <span className="mr-1.5 inline-block w-3 text-mist-400">{open ? "▾" : "▸"}</span>
            )}
            {nothing && <span className="mr-1.5 inline-block w-3" />}
            {room.label}
          </span>
          {/* The full takeoff wraps badly in a 320px rail, so the rail shows
              only the floor area and the scope page keeps the rest. */}
          <span className="ml-2 text-[11px] text-mist-400">
            {compact ? (
              `${Math.round(room.takeoff.floorSqft)} sqft`
            ) : (
              <>
                {Math.round(room.takeoff.floorSqft)} sqft floor ·{" "}
                {Math.round(room.takeoff.wallSqft)} sqft wall ·{" "}
                {Math.round(room.takeoff.baseboardLf)} lf trim
              </>
            )}
          </span>
          {room.unknownElements.length > 0 && (
            // Spelled out on the scope page, counted in the rail. Nine element
            // names wrap to three lines there and bury the room they belong to.
            <div className="mt-0.5 text-[11px] text-warn">
              {compact
                ? `${room.unknownElements.length} not seen`
                : `Not seen: ${room.unknownElements.join(", ")}`}
            </div>
          )}
        </span>
        <span className="tabular-nums text-sm text-mist-200">
          {nothing ? <span className="text-mist-400">nothing needed</span> : money(room.total)}
        </span>
      </button>
      {open &&
        room.assemblies.map((assembly) => (
          <Assembly key={`${room.roomId}-${assembly.name}`} assembly={assembly} />
        ))}
    </div>
  );
}

export function BomTree({
  bom,
  compact = false,
  selectedRoomId = null,
  onlyRoomId = null,
  onSelectRoom,
}: {
  bom: Bom;
  /** Narrow enough that the full takeoff line will not fit. */
  compact?: boolean;
  /** Highlighted and forced open - driven by what is selected in the model. */
  selectedRoomId?: string | null;
  /**
   * Show one room as its own project, rather than the house with a row lit up.
   *
   * Three things have to move together or the number is wrong: the whole-house
   * block goes, the other rooms go, and the footer stops being the house's
   * total. Filtering the list while leaving the footer alone would put the
   * price of a re-roof under one bedroom's name.
   */
  onlyRoomId?: string | null;
  onSelectRoom?: (roomId: string) => void;
}) {
  const only = onlyRoomId ? bom.rooms.find((r) => r.roomId === onlyRoomId) ?? null : null;
  const rooms = only ? [only] : bom.rooms;
  const levels = [...new Set(rooms.map((r) => r.level))].sort((a, b) => a - b);

  const footer = only
    ? {
        label: only.label,
        total: only.total,
        material: only.material,
        labour: only.labour,
        lines: only.assemblies.reduce((sum, a) => sum + a.lines.length, 0),
      }
    : {
        label: "Total",
        total: bom.total,
        material: bom.material,
        labour: bom.labour,
        lines: bom.lineCount,
      };

  return (
    <div className={compact ? "" : "rounded-lg border border-ink-600 bg-ink-800"}>
      {/* Roof, systems and exterior belong to no room, so a room on its own
          must not carry them - not even as context, since anything in this
          column reads as part of the figure at the bottom of it. */}
      {!only && bom.house.length > 0 && (
        <div className="border-b border-ink-700" data-house-block>
          <div className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2.5">
            <span className="text-sm font-medium text-mist-200">
              Whole house
              <span className="ml-2 text-[11px] text-mist-400">
                {compact ? "roof, systems, exterior" : "roof, systems and exterior — belongs to no single room"}
              </span>
            </span>
            <span className="tabular-nums text-sm text-mist-200">{money(bom.houseTotal)}</span>
          </div>
          {bom.house.map((assembly) => (
            <Assembly key={`house-${assembly.name}`} assembly={assembly} />
          ))}
        </div>
      )}

      {levels.map((level) => (
        <div key={level}>
          {levels.length > 1 && (
            <div className="bg-ink-700/50 px-3 py-1 text-[11px] uppercase tracking-wide text-mist-400">
              {level === 0 ? "Ground floor" : level > 0 ? "Upstairs" : "Basement"}
            </div>
          )}
          {rooms
            .filter((r) => r.level === level)
            .map((room) => (
              <Room
                key={room.roomId}
                room={room}
                compact={compact}
                // In the rail everything starts closed: a dozen open rooms is a
                // wall of text, and the model is what picks one out.
                defaultOpen={!compact && room.total > 0}
                selected={room.roomId === selectedRoomId}
                onSelect={onSelectRoom}
              />
            ))}
        </div>
      ))}

      <div
        className="grid grid-cols-[1fr_auto] gap-3 border-t border-ink-600 px-3 py-3"
        data-tree-total
        data-room={only ? only.roomId : undefined}
      >
        <span className="text-sm font-semibold text-mist-200">{footer.label}</span>
        <span className="text-right">
          <div className="tabular-nums text-lg font-semibold text-mist-200">
            {money(footer.total)}
          </div>
          <div className="text-[11px] text-mist-400">
            {money(footer.material)} material · {money(footer.labour)} labour · {footer.lines} lines
          </div>
        </span>
      </div>
    </div>
  );
}
