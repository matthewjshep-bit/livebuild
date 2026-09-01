"use client";

import { useEffect, useState } from "react";

import { listPropertyIds, loadProperty } from "@/lib/property-store";
import { type PublishedTour, listPublished } from "@/lib/cloud/sync";
import { listIntakes } from "@/lib/storage/intake";

type Entry = {
  id: string;
  label: string;
  rooms: number;
  nodes: number;
  bundled: boolean;
  /** Photographs gathered so far, for a tour that has not been built yet. */
  photos: number;
  /** Still being imported: it has an intake record and no rooms. */
  importing: boolean;
};

const BUNDLED = ["demo-house", "two-storey"];

export default function Home() {
  const [entries, setEntries] = useState<Entry[]>([]);
  /**
   * Tours that have been published, from wherever they were published.
   *
   * The list above is this browser's local storage, which is the right home for
   * work in progress and the wrong one for anything shared: a house built on a
   * laptop is invisible on the phone, and a published tour was invisible
   * everywhere, because the unguessable slug that makes a link safe to send
   * also makes it impossible to find again. Null until the answer is known, so
   * a browser with no passphrase shows nothing rather than an empty state that
   * would read as "you have published nothing".
   */
  const [published, setPublished] = useState<PublishedTour[] | null>(null);

  useEffect(() => {
    void listPublished().then(setPublished);
  }, []);

  useEffect(() => {
    const saved = listPropertyIds().map((id) => {
      const p = loadProperty(id);
      return {
        id,
        label: p?.label || id,
        rooms: p?.plan.rooms.length ?? 0,
        nodes: p?.nodes.length ?? 0,
        bundled: false,
        // Filled in below from the import records. A tour with no rooms is
        // either still importing or a document that failed to load, and those
        // two look identical from here - which is why the record is asked.
        photos: 0,
        importing: false,
      };
    });

    const missing = BUNDLED.filter((id) => !saved.some((s) => s.id === id));

    // The import records and the bundled samples are gathered together and the
    // list is set once. Applying them separately raced: the intake pass ran
    // against an empty list and the bundled pass then overwrote it, so a tour
    // that was still importing rendered as a finished one with no rooms.
    void Promise.all([
      listIntakes(),
      Promise.all(
      missing.map(async (id) => {
        const res = await fetch(`/properties/${id}/property.json`);
        if (!res.ok) return null;
        const p = await res.json();
        return {
          id,
          label: p.label || id,
          rooms: p.plan?.rooms?.length ?? 0,
          nodes: p.nodes?.length ?? 0,
          bundled: true,
          photos: 0,
          importing: false,
        } as Entry;
      }),
      ),
    ]).then(([pending, found]) => {
      const byId = new Map(pending.map((intake) => [intake.propertyId, intake]));
      const withProgress = saved.map((entry) => {
        const intake = byId.get(entry.id);
        // A tour with rooms has been built; a leftover record does not make it
        // unfinished again.
        return intake && entry.rooms === 0
          ? { ...entry, importing: true, photos: intake.photos.length }
          : entry;
      });
      const bundled = found.filter((e): e is Entry => e !== null);
      setEntries([...withProgress, ...bundled]);
    });
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">MatterMatt</h1>
      <p className="mt-2 text-sm leading-relaxed text-mist-400">
        Turn a folder of house photos into a walkthrough you can move around in.
        No special camera, no floor plan needed.
      </p>

      <a
        href="/new"
        className="mt-6 flex items-center justify-between rounded-xl bg-accent px-5 py-4 text-ink-900 transition hover:brightness-110"
      >
        <span>
          <span className="block text-base font-semibold">Make a tour</span>
          <span className="block text-sm opacity-80">
            Drop in photos, say which room each one is, done
          </span>
        </span>
        <span className="text-2xl">→</span>
      </a>

      <h2 className="mt-10 mb-3 text-xs uppercase tracking-wide text-mist-400">
        Your tours
      </h2>
      <div className="space-y-2">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="flex items-center justify-between rounded border border-ink-600 bg-ink-800 px-4 py-3"
          >
            <div>
              <div className="text-sm font-medium">{entry.label}</div>
              <div className="text-xs text-mist-400">
                {entry.importing ? (
                  <span className="text-accent">
                    still importing &middot; {entry.photos} photo
                    {entry.photos === 1 ? "" : "s"}
                  </span>
                ) : (
                  <>
                    {entry.rooms} rooms &middot; {entry.nodes} viewpoints
                    {entry.bundled && " · bundled sample"}
                  </>
                )}
              </div>
            </div>
            {/* An unfinished tour has no model, no scope and nothing to edit,
                so offering all three would be three ways to reach an empty
                room. One button, back to where the work is. */}
            {entry.importing ? (
              <a
                href={`/new?id=${entry.id}`}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-ink-900"
              >
                Continue building
              </a>
            ) : (
            <div className="flex gap-2">
              <a
                href={`/tour/${entry.id}`}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-ink-900"
              >
                Open tour
              </a>
              <a
                href={`/bom/${entry.id}`}
                className="rounded border border-ink-500 px-3 py-1.5 text-xs"
              >
                Scope &amp; costs
              </a>
              <a
                href={`/editor?id=${entry.id}`}
                className="rounded border border-ink-500 px-3 py-1.5 text-xs"
              >
                Edit
              </a>
            </div>
            )}
          </div>
        ))}

        {entries.length === 0 && (
          <p className="rounded border border-dashed border-ink-600 px-4 py-8 text-center text-sm text-mist-400">
            Nothing here yet. Make your first tour above.
          </p>
        )}
      </div>

      {published && published.length > 0 && (
        <>
          <h2 className="mt-10 mb-1 text-xs uppercase tracking-wide text-mist-400">
            Published
          </h2>
          <p className="mb-3 text-xs leading-relaxed text-mist-400">
            Live on the web at an unguessable link, from any machine that published
            one. Anybody with the link can open it; nobody can find it without.
          </p>
          <div className="space-y-2">
            {published.map((tour) => (
              <div
                key={tour.slug}
                className="flex items-center justify-between rounded border border-ink-600 bg-ink-800 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {tour.label || "Untitled"}
                  </div>
                  <div className="text-xs text-mist-400">
                    {tour.photo_count} photo{tour.photo_count === 1 ? "" : "s"} &middot;{" "}
                    {new Date(tour.updated_at).toLocaleDateString()} &middot;{" "}
                    <span className="font-mono">/t/{tour.slug}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <a
                    href={`/t/${tour.slug}`}
                    className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-ink-900"
                  >
                    Open
                  </a>
                  <button
                    onClick={() => {
                      void navigator.clipboard?.writeText(
                        `${window.location.origin}/t/${tour.slug}`,
                      );
                    }}
                    className="rounded border border-ink-500 px-3 py-1.5 text-xs"
                  >
                    Copy link
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mt-6 flex gap-4 text-xs text-mist-400">
        <a href="/storage" className="underline underline-offset-4 hover:text-mist-200">
          Storage &amp; backups
        </a>
        <a href="/editor" className="underline underline-offset-4 hover:text-mist-200">
          Advanced: place rooms manually
        </a>
      </div>
    </main>
  );
}
