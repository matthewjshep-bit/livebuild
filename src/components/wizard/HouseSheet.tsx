"use client";

import { useMemo } from "react";

import {
  ASSUMED,
  type HouseSheet as Sheet,
  type SheetRoom,
  sheetToSpec,
} from "@/lib/plan/house-sheet";
import { levelName } from "@/lib/plan/geometry";

/**
 * The house, in controls.
 *
 * What this replaces was a `<textarea>` read by a regex, behind a collapsed
 * disclosure triangle, in a product whose whole premise is that you should not
 * have to type. It was also the only place the bedroom count could be corrected
 * - the number that decides how many bedrooms the built house has.
 *
 * Everything here is a press. The arithmetic lives in `house-sheet.ts` and is
 * tested against the parser it replaces, so this file is only ever about how it
 * looks and what it lets you reach.
 */

/** Rooms worth offering, beyond the ones every house is assumed to have. */
const EXTRA_ROOMS = [
  "Dining Room",
  "Office",
  "Laundry",
  "Garage",
  "Entry",
  "Closet",
  "Pantry",
  "Family Room",
  "Sunroom",
  "Bonus Room",
];

function Stepper({
  label,
  value,
  onChange,
  step = 1,
  min = 0,
  max = 12,
  format,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  step?: number;
  min?: number;
  max?: number;
  format?: (n: number) => string;
}) {
  const button =
    "grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-ink-500 text-lg " +
    "text-mist-200 transition hover:bg-ink-600 disabled:opacity-40";
  return (
    <div>
      <p className="text-xs font-medium text-mist-200">{label}</p>
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          aria-label={`One fewer ${label.toLowerCase()}`}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, Number((value - step).toFixed(1))))}
          className={button}
        >
          −
        </button>
        <span
          className="min-w-14 text-center text-lg font-semibold tabular-nums"
          aria-live="polite"
        >
          {format ? format(value) : value}
        </span>
        <button
          type="button"
          aria-label={`One more ${label.toLowerCase()}`}
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, Number((value + step).toFixed(1))))}
          className={button}
        >
          +
        </button>
      </div>
    </div>
  );
}

function Chip({
  on,
  onClick,
  children,
  title,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      onClick={onClick}
      className={`min-h-11 rounded-lg border px-3 py-2 text-sm transition ${
        on
          ? "border-accent bg-accent text-ink-900"
          : "border-ink-500 bg-ink-800 text-mist-200 hover:border-accent-dim hover:bg-ink-700"
      }`}
    >
      {children}
    </button>
  );
}

export function HouseSheet({
  sheet,
  onChange,
  prefilled,
}: {
  sheet: Sheet;
  onChange: (next: Sheet) => void;
  /** True when a listing filled this in, so the user knows why it is not empty. */
  prefilled?: boolean;
}) {
  const set = (patch: Partial<Sheet>) => onChange({ ...sheet, ...patch });
  const spec = useMemo(() => sheetToSpec(sheet), [sheet]);

  const levels = useMemo(() => {
    const used = [...new Set(spec.rooms.map((r) => r.level))].sort((a, z) => a - z);
    return used.length > 0 ? used : [0];
  }, [spec]);

  const toggleExtra = (label: string) => {
    const has = sheet.extras.some((r) => r.label === label);
    set({
      extras: has
        ? sheet.extras.filter((r) => r.label !== label)
        : [...sheet.extras, { label, level: 0 } satisfies SheetRoom],
    });
  };

  const moveExtra = (label: string, level: number) =>
    set({ extras: sheet.extras.map((r) => (r.label === label ? { ...r, level } : r)) });

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h2 className="text-lg font-medium">What is in the house?</h2>
      <p className="mt-1 text-sm leading-relaxed text-mist-400">
        {prefilled
          ? "Taken from the listing. Correct anything it got wrong — the bedroom count is what decides how many bedrooms get built."
          : "Enough to know what to build. The bedroom count is what decides how many bedrooms the house ends up with."}
      </p>

      {/* The numbers. */}
      <div className="mt-5 flex flex-wrap items-start gap-x-8 gap-y-5 rounded-lg border border-ink-600 bg-ink-800 px-4 py-4">
        <Stepper label="Bedrooms" value={sheet.beds} onChange={(beds) => set({ beds })} />
        <Stepper
          label="Bathrooms"
          value={sheet.baths}
          step={0.5}
          max={9}
          onChange={(baths) => set({ baths })}
          // A half is a room without a shower, and saying so beats "2.5".
          format={(n) => (Number.isInteger(n) ? String(n) : `${Math.floor(n)}½`)}
        />
        <Stepper
          label="Floors"
          value={sheet.storeys}
          min={1}
          max={3}
          onChange={(storeys) => set({ storeys })}
        />
        <div>
          <label htmlFor="sheet-sqft" className="text-xs font-medium text-mist-200">
            Floor area
          </label>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              id="sheet-sqft"
              type="number"
              inputMode="numeric"
              min={100}
              max={20000}
              value={sheet.sqft ?? ""}
              placeholder="optional"
              onChange={(e) =>
                set({ sqft: e.target.value === "" ? null : Number(e.target.value) })
              }
              className="h-11 w-32 rounded-lg border border-ink-600 bg-ink-700 px-3 text-sm outline-none focus:border-accent-dim"
            />
            <span className="text-xs text-mist-400">sq ft</span>
          </div>
        </div>
      </div>

      {/* The two that change the shape of the house rather than its count. */}
      <div className="mt-3 flex flex-wrap gap-2">
        <Chip
          on={sheet.hasPrimary}
          onClick={() => set({ hasPrimary: !sheet.hasPrimary })}
          title="A primary suite, with its own bathroom"
        >
          Primary suite
        </Chip>
        <Chip on={sheet.hasBasement} onClick={() => set({ hasBasement: !sheet.hasBasement })}>
          Basement
        </Chip>
      </div>

      {/* Everything else. */}
      <div className="mt-5">
        <p className="text-xs font-medium uppercase tracking-wide text-mist-400">
          Other rooms
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {EXTRA_ROOMS.map((label) => (
            <Chip
              key={label}
              on={sheet.extras.some((r) => r.label === label)}
              onClick={() => toggleExtra(label)}
            >
              {label}
            </Chip>
          ))}
        </div>
      </div>

      {/*
        The rooms nobody thinks to mention.

        The parser added these silently, on the reasoning that a description is
        a summary rather than an inventory - which is right, and the silence was
        not. Here they are shown already chosen, and can be taken away.
      */}
      <div className="mt-5">
        <p className="text-xs font-medium uppercase tracking-wide text-mist-400">
          Every house is assumed to have these
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {ASSUMED.map((label) => (
            <Chip
              key={label}
              on={!sheet.removed.includes(label)}
              title="Tap to remove"
              onClick={() =>
                set({
                  removed: sheet.removed.includes(label)
                    ? sheet.removed.filter((r) => r !== label)
                    : [...sheet.removed, label],
                })
              }
            >
              {label}
            </Chip>
          ))}
        </div>
      </div>

      {/*
        What that adds up to, shown back.

        The old box had a result card for the same reason: a house being built
        with the wrong number of bedrooms is worth noticing before it is built,
        not after.
      */}
      <div
        className="mt-5 rounded-lg border border-ink-600 bg-ink-800 px-4 py-3"
        data-testid="sheet-summary"
      >
        <p className="text-xs text-mist-400">
          {spec.rooms.length} rooms
          {levels.length > 1 ? ` across ${levels.length} floors` : ""}
        </p>
        {levels.map((level) => {
          const here = spec.rooms.filter((r) => r.level === level);
          if (here.length === 0) return null;
          return (
            <div key={level} className="mt-2">
              {levels.length > 1 && (
                <p className="text-xs uppercase tracking-wide text-mist-400">
                  {levelName(level)}
                </p>
              )}
              <div className="mt-1 flex flex-wrap gap-1.5">
                {here.map((room) => {
                  const extra = sheet.extras.find((r) => r.label === room.label);
                  return extra && levels.length > 1 ? (
                    // An added room can be put on a different floor; the ones
                    // that follow from the counts go where the counts put them.
                    <select
                      key={`${room.label}@${room.level}`}
                      value={extra.level}
                      aria-label={`Which floor ${room.label} is on`}
                      onChange={(e) => moveExtra(room.label, Number(e.target.value))}
                      className="rounded border border-ink-500 bg-ink-700 px-2 py-1 text-xs text-mist-200"
                    >
                      {levels.map((l) => (
                        <option key={l} value={l}>
                          {room.label} · {levelName(l)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span
                      key={`${room.label}@${room.level}`}
                      className="rounded bg-ink-600 px-2 py-1 text-xs text-mist-200"
                    >
                      {room.label}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
