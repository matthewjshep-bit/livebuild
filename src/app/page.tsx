"use client";

import { useEffect, useState } from "react";

import { listPropertyIds, loadProperty } from "@/lib/property-store";

type Entry = { id: string; label: string; rooms: number; nodes: number; bundled: boolean };

const BUNDLED = ["demo-house", "two-storey"];

export default function Home() {
  const [entries, setEntries] = useState<Entry[]>([]);

  useEffect(() => {
    const saved = listPropertyIds().map((id) => {
      const p = loadProperty(id);
      return {
        id,
        label: p?.label || id,
        rooms: p?.plan.rooms.length ?? 0,
        nodes: p?.nodes.length ?? 0,
        bundled: false,
      };
    });

    const missing = BUNDLED.filter((id) => !saved.some((s) => s.id === id));
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
        } as Entry;
      }),
    ).then((found) => {
      const bundled = found.filter((e): e is Entry => e !== null);
      setEntries([...saved, ...bundled]);
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
                {entry.rooms} rooms &middot; {entry.nodes} viewpoints
                {entry.bundled && " · bundled sample"}
              </div>
            </div>
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
          </div>
        ))}

        {entries.length === 0 && (
          <p className="rounded border border-dashed border-ink-600 px-4 py-8 text-center text-sm text-mist-400">
            Nothing here yet. Make your first tour above.
          </p>
        )}
      </div>

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
