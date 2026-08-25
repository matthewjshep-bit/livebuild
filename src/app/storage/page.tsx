"use client";

import { useCallback, useEffect, useState } from "react";

import { deleteMediaFor, mediaSizes } from "@/lib/media-store";
import {
  deleteProperty,
  downloadProperty,
  listPropertyIds,
  loadProperty,
  saveProperty,
} from "@/lib/property-store";
import { formatBytes, requestPersistence, storageUsage } from "@/lib/storage/db";
import { type Draft, clearDraft, loadDraft } from "@/lib/storage/drafts";
import { parseProperty } from "@/lib/schema";

/**
 * What is actually stored, and what to do about it.
 *
 * Everything lives in this browser - no account, no server - which is fine
 * until something goes missing, at which point there is nowhere to look. This
 * is the place to look: what exists, how much room it takes, and how to get a
 * copy out before clearing site data takes it away.
 */

type Row = {
  id: string;
  label: string;
  rooms: number;
  nodes: number;
  withDepth: number;
  bytes: number;
};

export default function StoragePanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftBytes, setDraftBytes] = useState(0);
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  /**
   * Measured from what we actually hold, rather than taken from
   * `navigator.storage.estimate()`.
   *
   * The browser's own figure is coarse and lags behind writes - it happily
   * reported 4 KB while 94 KB of photos sat in IndexedDB - which reads as data
   * having gone missing on the very page someone opens to check that it has
   * not. The quota still comes from the browser; only the usage is ours.
   */
  const [measured, setMeasured] = useState(0);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(true);

  const refresh = useCallback(async () => {
    setBusy(true);
    const sizes = await mediaSizes();

    const bytesUnder = (prefix: string) => {
      let total = 0;
      for (const [key, size] of sizes) {
        if (key.startsWith(prefix)) total += size;
      }
      return total;
    };

    setRows(
      listPropertyIds().map((id) => {
        const property = loadProperty(id);
        return {
          id,
          label: property?.label || id,
          rooms: property?.plan.rooms.length ?? 0,
          nodes: property?.nodes.length ?? 0,
          withDepth: property?.nodes.filter((n) => n.depth).length ?? 0,
          bytes: bytesUnder(`${id}/`),
        };
      }),
    );

    const current = await loadDraft();
    setDraft(current);
    setDraftBytes(current ? bytesUnder(`${current.propertyId}/`) : 0);
    let total = 0;
    for (const size of sizes.values()) total += size;
    setMeasured(total);

    setUsage(await storageUsage());
    setBusy(false);
  }, []);

  useEffect(() => {
    void refresh();
    void navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
  }, [refresh]);

  const importFile = async (file: File) => {
    try {
      const property = parseProperty(JSON.parse(await file.text()));
      saveProperty(property);
      await refresh();
    } catch {
      alert("That does not look like a MatterMatt tour file.");
    }
  };

  return (
    <main className="mx-auto max-w-2xl px-6 py-14">
      <a href="/" className="text-xs text-mist-400 underline underline-offset-4">
        ← Back
      </a>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Storage</h1>
      <p className="mt-2 text-sm leading-relaxed text-mist-400">
        Everything is saved in this browser &ndash; there is no account and nothing is
        uploaded. That also means clearing site data, or using a different browser or
        device, will not find it. Export anything you want to keep.
      </p>

      <div className="mt-6 rounded-lg border border-ink-600 bg-ink-800 p-4">
        <div className="flex items-baseline justify-between text-sm">
          <span>{formatBytes(measured)} of photos and depth maps</span>
          {usage && (
            <span className="text-xs text-mist-400">
              of about {formatBytes(usage.quota)} available
            </span>
          )}
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-600">
          <div
            className="h-full bg-accent"
            style={{
              width: `${Math.min(100, (measured / Math.max(usage?.quota ?? 1, 1)) * 100)}%`,
            }}
          />
        </div>
          <p className="mt-2 text-[11px] text-mist-400">
            {persisted
              ? "This browser has agreed to keep your data even when storage runs low."
              : "Storage is best-effort: the browser may clear it if the device runs low."}
            {!persisted && (
              <button
                onClick={() => void requestPersistence().then(setPersisted)}
                className="ml-1 underline underline-offset-2"
              >
                Ask it not to
              </button>
            )}
        </p>
      </div>

      {draft && (
        <>
          <h2 className="mt-8 mb-2 text-xs uppercase tracking-wide text-mist-400">
            In progress
          </h2>
          <div className="flex items-center justify-between rounded border border-ink-600 bg-ink-800 px-4 py-3">
            <div>
              <div className="text-sm font-medium">
                {draft.label || "Unnamed tour"}{" "}
                <span className="text-xs font-normal text-mist-400">
                  &middot; step {draft.step}
                </span>
              </div>
              <div className="text-xs text-mist-400">
                {draft.photos.length} photos &middot; {formatBytes(draftBytes)} &middot; saved{" "}
                {new Date(draft.updatedAt).toLocaleString()}
              </div>
            </div>
            <div className="flex gap-2">
              <a
                href="/new"
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-ink-900"
              >
                Resume
              </a>
              <button
                onClick={async () => {
                  if (!confirm("Discard this in-progress tour and its photos?")) return;
                  await clearDraft(true);
                  await refresh();
                }}
                className="rounded border border-ink-500 px-3 py-1.5 text-xs text-warn"
              >
                Discard
              </button>
            </div>
          </div>
        </>
      )}

      <h2 className="mt-8 mb-2 text-xs uppercase tracking-wide text-mist-400">
        Saved tours
      </h2>
      <div className="space-y-2">
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex items-center justify-between rounded border border-ink-600 bg-ink-800 px-4 py-3"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{row.label}</div>
              <div className="text-xs text-mist-400">
                {row.rooms} rooms &middot; {row.nodes} viewpoints &middot;{" "}
                {row.withDepth === row.nodes ? (
                  "all 3D"
                ) : (
                  <span className="text-warn">
                    {row.nodes - row.withDepth} still flat
                  </span>
                )}
                {row.bytes > 0 && ` · ${formatBytes(row.bytes)}`}
              </div>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <a
                href={`/tour/${row.id}`}
                className="rounded border border-ink-500 px-2.5 py-1.5 text-xs"
              >
                Open
              </a>
              <button
                onClick={() => {
                  const property = loadProperty(row.id);
                  if (property) downloadProperty(property);
                }}
                className="rounded border border-ink-500 px-2.5 py-1.5 text-xs"
                title="Download the plan as JSON. Photos stay in this browser."
              >
                Export
              </button>
              <button
                onClick={async () => {
                  if (!confirm(`Delete "${row.label}" and its photos? This cannot be undone.`))
                    return;
                  deleteProperty(row.id);
                  await deleteMediaFor(`${row.id}/`);
                  await refresh();
                }}
                className="rounded border border-ink-500 px-2.5 py-1.5 text-xs text-warn"
              >
                Delete
              </button>
            </div>
          </div>
        ))}

        {rows.length === 0 && !busy && (
          <p className="rounded border border-dashed border-ink-600 px-4 py-8 text-center text-sm text-mist-400">
            Nothing saved yet.
          </p>
        )}
      </div>

      <label className="mt-6 inline-block cursor-pointer text-xs text-mist-400 underline underline-offset-4 hover:text-mist-200">
        Import a tour file
        <input
          type="file"
          accept="application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importFile(file);
            e.target.value = "";
          }}
        />
      </label>
      <p className="mt-2 text-[11px] leading-relaxed text-mist-400">
        Export saves the plan, not the photos &ndash; those stay in this browser. An imported
        plan will show its rooms and dollhouse, and its photos will be missing.
      </p>
    </main>
  );
}
