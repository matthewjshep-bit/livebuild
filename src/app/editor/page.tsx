"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { PlanEditor } from "@/components/editor/PlanEditor";
import { fetchBundledProperty, loadProperty } from "@/lib/property-store";
import { M_PER_FT } from "@/lib/units";
import type { Property } from "@/lib/schema";

/** A blank property, drawn on a foot grid so scaleRef starts already correct. */
function emptyProperty(id: string): Property {
  return {
    id,
    label: "",
    displayUnits: "ft",
    plan: { scaleRef: { px: 1, meters: M_PER_FT }, rooms: [], openings: [] },
    nodes: [],
    splats: [],
    // Filled in once someone grades the property; the BOM treats an empty
    // map as 'nothing seen yet' rather than 'nothing needed'.
    condition: {},
    houseCondition: {},
    rates: {},
  };
}

function slugFromDate(): string {
  // Date-based rather than random so two properties made on different days sort
  // sensibly, and the id stays readable in a URL.
  const now = new Date();
  return `plan-${now.toISOString().slice(0, 10)}-${now.getHours()}${String(
    now.getMinutes(),
  ).padStart(2, "0")}`;
}

function EditorInner() {
  const params = useSearchParams();
  const id = params.get("id");
  const [property, setProperty] = useState<Property | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!id) return emptyProperty(slugFromDate());
      // The editor deliberately reads the *unhydrated* document: it stores and
      // edits `idb:` references, and resolving them to object URLs here would
      // write those temporary URLs straight back into the saved file.
      return loadProperty(id) ?? (await fetchBundledProperty(id)) ?? emptyProperty(id);
    }

    load().then((found) => {
      if (!cancelled) setProperty(found);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!property) {
    return (
      <div className="app-shell items-center justify-center text-sm text-mist-400">
        Loading editor...
      </div>
    );
  }

  return <PlanEditor initial={property} />;
}

export default function EditorPage() {
  return (
    <Suspense
      fallback={
        <div className="app-shell items-center justify-center text-sm text-mist-400">
          Loading editor...
        </div>
      }
    >
      <EditorInner />
    </Suspense>
  );
}
