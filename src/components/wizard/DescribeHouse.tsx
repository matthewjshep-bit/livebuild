"use client";

import { useState } from "react";

import { EXAMPLE_DESCRIPTIONS, type HouseSpec, describeToSpec } from "@/lib/plan/describe";

/**
 * Describe the house in a sentence, and get a first-pass floor plan.
 *
 * Optional, and skippable in one click - but doing it changes two things
 * downstream: the layout arrives already close, and the room buttons in the
 * next step read "Primary Bedroom / Bedroom 2 / Bedroom 3" instead of a single
 * generic "Bedroom" that cannot tell three of them apart.
 *
 * The offline parser runs first and instantly. The AI pass is tried afterwards
 * and only replaces the result if it succeeds, so a missing key, a rate limit
 * or being offline costs nothing.
 */
export function DescribeHouse({
  text,
  spec,
  onChange,
}: {
  text: string;
  spec: HouseSpec | null;
  onChange: (text: string, spec: HouseSpec | null) => void;
}) {
  const [thinking, setThinking] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);

  const interpret = async (value: string) => {
    if (value.trim().length < 3) {
      onChange(value, null);
      setAiNote(null);
      return;
    }

    // Parse locally first so there is always a result on screen immediately.
    const local = describeToSpec(value);
    onChange(value, local);

    setThinking(true);
    setAiNote(null);
    try {
      const res = await fetch("/api/describe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: value }),
      });

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.rooms) && data.rooms.length > 0) {
          onChange(value, { rooms: data.rooms, notes: data.notes ?? [], source: "ai" });
        }
      } else if (res.status === 501) {
        setAiNote("Read locally. Add an API key to .env.local for the AI pass.");
      } else {
        setAiNote("The AI pass was unavailable, so this was read locally.");
      }
    } catch {
      setAiNote("Offline, so this was read locally.");
    } finally {
      setThinking(false);
    }
  };

  const grouped = spec
    ? [...new Set(spec.rooms.map((r) => r.level))]
        .sort((a, b) => b - a)
        .map((level) => ({
          level,
          labels: spec.rooms.filter((r) => r.level === level).map((r) => r.label),
        }))
    : [];

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h2 className="text-lg font-medium">Describe the house</h2>
      <p className="mt-1 text-sm text-mist-400">
        One or two sentences is plenty. This gives you a floor plan to start from instead of a
        blank grid &ndash; skip it if you would rather build the layout by hand.
      </p>

      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value, spec)}
        onBlur={(e) => void interpret(e.target.value)}
        rows={3}
        placeholder="e.g. 3 bed 2 bath single storey, open plan kitchen and living room, 2 car garage"
        className="mt-4 w-full resize-y rounded-lg border border-ink-600 bg-ink-700 px-3 py-2.5 text-sm outline-none focus:border-accent-dim"
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void interpret(text)}
          disabled={thinking || text.trim().length < 3}
          className="rounded bg-accent px-4 py-1.5 text-xs font-medium text-ink-900 disabled:opacity-35"
        >
          {thinking ? "Reading…" : "Read it"}
        </button>
        {!spec && (
          <span className="text-xs text-mist-400">
            or try:{" "}
            <button
              onClick={() => void interpret(EXAMPLE_DESCRIPTIONS[0])}
              className="underline underline-offset-2 hover:text-mist-200"
            >
              an example
            </button>
          </span>
        )}
      </div>

      {spec && (
        <div className="mt-5 rounded-lg border border-ink-600 bg-ink-800 p-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-medium">
              {spec.rooms.length} rooms
              {grouped.length > 1 && ` across ${grouped.length} floors`}
            </h3>
            <span className="text-[11px] text-mist-400">
              {spec.source === "ai" ? "read by Claude" : "read locally"}
            </span>
          </div>

          {spec.notes.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-mist-400">
              {spec.notes.map((note, i) => (
                <li key={i}>&middot; {note}</li>
              ))}
            </ul>
          )}

          <div className="mt-3 space-y-2">
            {grouped.map(({ level, labels }) => (
              <div key={level}>
                <div className="text-[11px] uppercase tracking-wide text-mist-400">
                  {level === 0 ? "Ground floor" : level > 0 ? "Upstairs" : "Basement"}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {labels.map((label, i) => (
                    <span
                      key={`${label}-${i}`}
                      className="rounded bg-ink-600 px-2 py-0.5 text-[11px]"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-mist-400">
            Wrong somewhere? Edit the sentence above, or fix it directly in the next steps
            &ndash; nothing here is locked in.
          </p>
        </div>
      )}

      {aiNote && <p className="mt-3 text-[11px] text-mist-400">{aiNote}</p>}
    </div>
  );
}
