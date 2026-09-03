"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";

import { TourViewer } from "@/components/tour/TourViewer";
import { resolveProperty } from "@/lib/property-store";
import type { Property } from "@/lib/schema";

export default function TourPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [property, setProperty] = useState<Property | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");

  useEffect(() => {
    let cancelled = false;
    resolveProperty(id).then((found) => {
      if (cancelled) return;
      setProperty(found);
      setState(found ? "ready" : "missing");
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  /**
   * Pick up the photographs as they are read.
   *
   * The read runs on the page that built the house and writes each room to
   * storage as it lands. A tour open in another tab loaded once and never
   * looked again, so it showed the room list's guess for as long as it stayed
   * open. `storage` fires in every *other* tab on a write, which is exactly
   * the tab this is.
   */
  useEffect(() => {
    const refresh = (event: StorageEvent) => {
      if (event.key && !event.key.includes(id)) return;
      resolveProperty(id).then((found) => {
        if (found) setProperty(found);
      });
    };
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [id]);

  if (state === "loading") {
    return <Centered>Loading tour...</Centered>;
  }

  if (state === "missing" || !property) {
    return (
      <Centered>
        <p className="mb-3">No property called &ldquo;{id}&rdquo;.</p>
        <Link href="/" className="text-accent underline underline-offset-4">
          Back to properties
        </Link>
      </Centered>
    );
  }

  return <TourViewer property={property} onPropertyChange={setProperty} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell items-center justify-center text-center text-sm text-mist-400">
      <div>{children}</div>
    </div>
  );
}
