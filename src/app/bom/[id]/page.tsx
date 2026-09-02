"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { BomTree } from "@/components/bom/BomTree";
import { bomToCsv, buildBom } from "@/lib/bom/build";
import {
  GRADES,
  GRADE_HELP,
  GRADE_LABEL,
  type Grade,
  HOUSE_ELEMENTS,
  HOUSE_ELEMENT_LABEL,
} from "@/lib/bom/condition";
import { type GradeProgress, gradeExterior, gradeProperty } from "@/lib/bom/grade-client";
import { fetchBundledProperty, loadProperty, saveProperty } from "@/lib/property-store";
import type { Property } from "@/lib/schema";

/**
 * The bill of materials for one property.
 *
 * Quantities come from the model, scope from the condition of each room, money
 * from the rate card. The whole-project comparison beside the total is there so
 * a badly wrong rate card is visible rather than silent - the two numbers are
 * computed from entirely different things, so agreement means something.
 */
export default function BomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [property, setProperty] = useState<Property | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [grading, setGrading] = useState<GradeProgress | null>(null);
  const [gradeNote, setGradeNote] = useState<string | null>(null);
  const [canGrade, setCanGrade] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Deliberately the *unhydrated* document. The BOM needs the original photo
    // references to read images for grading, and hydration would have swapped
    // them for object URLs.
    //
    // Bundled samples fall back to their file, so the demo house can be costed
    // like any other - it is the first thing anyone will click.
    const load = async () =>
      loadProperty(id) ?? (await fetchBundledProperty(id));

    load().then((found) => {
      if (cancelled) return;
      setProperty(found);
      setState(found ? "ready" : "missing");
    });
    fetch("/api/condition")
      .then((r) => r.json())
      .then((d) => setCanGrade(Boolean(d.available)))
      .catch(() => setCanGrade(false));

    return () => {
      cancelled = true;
    };
  }, [id]);

  const bom = useMemo(
    () =>
      property
        ? buildBom(
            property.plan,
            property.condition,
            property.rates,
            property.houseCondition,
            property.kind ?? "house",
          )
        : null,
    [property],
  );

  const update = useCallback((next: Property) => {
    setProperty(next);
    saveProperty(next);
  }, []);

  const runGrading = async () => {
    if (!property) return;
    setGradeNote(null);
    const result = await gradeProperty(property, setGrading);

    // The building's own condition, from whatever exterior shots the listing
    // had. Without it the roof and siding stay unknown and cost nothing, which
    // is what made the first totals read low against the comparison bands.
    setGrading({ room: "the outside of the house", done: 0, total: 1 });
    const outside = await gradeExterior(property);
    setGrading(null);

    update({
      ...property,
      condition: result.condition,
      houseCondition: { ...property.houseCondition, ...outside.houseCondition },
    });

    const graded = Object.keys(outside.houseCondition).length;
    setGradeNote(
      `Graded ${result.graded} room${result.graded === 1 ? "" : "s"} from their photos.` +
        (outside.photos > 0
          ? ` Read the roof, siding and yard from ${outside.photos} exterior shot${outside.photos === 1 ? "" : "s"}${graded > 0 ? "" : ", though none could be judged"}.`
          : " No exterior photos, so the roof and siding are still unknown.") +
        // Said plainly rather than left to be discovered: nothing in a listing
        // shows a furnace, so those stay the user's to enter.
        " Heating, electrics and plumbing cannot be seen in photographs and stay unset." +
        (result.unseen > 0
          ? ` ${result.unseen} room${result.unseen === 1 ? "" : "s"} had no photo — set those by hand.`
          : ""),
    );
  };

  if (state === "loading") {
    return <Centered>Loading…</Centered>;
  }
  if (state === "missing" || !property || !bom) {
    return (
      <Centered>
        <p className="mb-3">No property called &ldquo;{id}&rdquo;.</p>
        <Link href="/" className="text-accent underline underline-offset-4">
          Back
        </Link>
      </Centered>
    );
  }

  const busy = grading !== null;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/" className="text-xs text-mist-400 underline underline-offset-4">
            ← All properties
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {property.label || property.id}
          </h1>
          <p className="mt-1 text-sm text-mist-400">
            Scope of work, priced from the model. {Math.round(bom.livingSqft)} sqft of living
            area across {property.plan.rooms.length} rooms.
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={`/tour/${property.id}`}
            className="rounded border border-ink-500 px-3 py-1.5 text-xs hover:bg-ink-600"
          >
            View model
          </a>
          <button
            onClick={() => {
              const blob = new Blob([bomToCsv(bom, property.label || property.id)], {
                type: "text/csv",
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${property.id}-bom.csv`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="rounded border border-ink-500 px-3 py-1.5 text-xs hover:bg-ink-600"
          >
            Export CSV
          </button>
        </div>
      </div>

      {/* The sanity check. Two numbers from different sources; agreement means
          something, and disagreement means one of them is wrong. */}
      <div className="mt-6 rounded-lg border border-ink-600 bg-ink-800 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm text-mist-400">Itemised total</span>
          <span className="text-2xl font-semibold tabular-nums">
            {bom.total.toLocaleString("en-US", {
              style: "currency",
              currency: "USD",
              maximumFractionDigits: 0,
            })}
          </span>
        </div>
        {/* A single room has no house-sized range to be compared against, so
            it is told nothing rather than told something untrue. */}
        {bom.sanity && (
          <p className="mt-2 text-xs leading-relaxed text-mist-400">{bom.sanity.summary}</p>
        )}
        {bom.assumedTotal > 0 && (
          <p className="mt-1.5 text-xs text-warn">
            {Math.round((bom.assumedTotal / Math.max(bom.total, 1)) * 100)}% of this rests on
            elements no photo showed.
          </p>
        )}
      </div>

      {canGrade && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={() => void runGrading()}
            disabled={busy}
            className="rounded bg-accent px-4 py-2 text-xs font-medium text-ink-900 disabled:opacity-40"
          >
            {busy
              ? `Looking at ${grading?.room || "the photos"}… ${grading?.done}/${grading?.total}`
              : "Grade condition from the photos"}
          </button>
          {gradeNote && <span className="text-xs text-mist-400">{gradeNote}</span>}
        </div>
      )}

      <h2 className="mt-8 mb-2 text-xs uppercase tracking-wide text-mist-400">
        Whole house condition
      </h2>
      <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {HOUSE_ELEMENTS.map((element) => (
          <label key={element} className="block">
            <span className="mb-1 block text-[11px] text-mist-400">
              {HOUSE_ELEMENT_LABEL[element]}
            </span>
            <select
              value={property.houseCondition[element] ?? "not_visible"}
              onChange={(e) =>
                update({
                  ...property,
                  houseCondition: {
                    ...property.houseCondition,
                    [element]: e.target.value as Grade,
                  },
                })
              }
              aria-label={HOUSE_ELEMENT_LABEL[element]}
              title={GRADE_HELP[(property.houseCondition[element] ?? "not_visible") as Grade]}
              className="w-full rounded border border-ink-600 bg-ink-700 px-2 py-1 text-xs outline-none focus:border-accent-dim"
            >
              {GRADES.map((grade) => (
                <option key={grade} value={grade}>
                  {GRADE_LABEL[grade]}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <BomTree bom={bom} />

      <p className="mt-4 text-[11px] leading-relaxed text-mist-400">
        Quantities are measured from the model, so they are only as accurate as the plan — a
        generated layout has approximate room sizes. Rates are editable defaults for a US
        mid-grade refurbishment and are yours to set.
      </p>
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center text-center text-sm text-mist-400">
      <div>{children}</div>
    </div>
  );
}
