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
import { type Intake, clearIntake, listIntakes } from "@/lib/storage/intake";
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
  bytes: number;
};

export default function StoragePanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [intakes, setIntakes] = useState<Array<Intake & { bytes: number }>>([]);
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
          bytes: bytesUnder(`${id}/`),
        };
      }),
    );

    const pending = await listIntakes();
    setIntakes(
      pending.map((intake) => ({ ...intake, bytes: bytesUnder(`${intake.propertyId}/`) })),
    );
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
          <span>{formatBytes(measured)} of photos</span>
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

      {intakes.length > 0 && (
        <>
          <h2 className="mt-8 mb-2 text-xs uppercase tracking-wide text-mist-400">
            Still importing
          </h2>
          <div className="space-y-2">
            {intakes.map((intake) => (
              <div
                key={intake.propertyId}
                className="flex items-center justify-between rounded border border-ink-600 bg-ink-800 px-4 py-3"
              >
                <div>
                  <div className="text-sm font-medium">{intake.label || "Unnamed tour"}</div>
                  <div className="text-xs text-mist-400">
                    {intake.photos.length} photos &middot;{" "}
                    {formatBytes(intake.bytes)} &middot; saved{" "}
                    {new Date(intake.updatedAt).toLocaleString()}
                  </div>
                </div>
                <div className="flex gap-2">
                  <a
                    href={`/new?id=${intake.propertyId}`}
                    className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-ink-900"
                  >
                    Continue
                  </a>
                  {/* Only the working state. The photographs belong to the tour
                      and go with it - deleting them from here is exactly the
                      bug that emptied finished tours. */}
                  <button
                    onClick={async () => {
                      if (!confirm("Forget where this import got to? The photos are kept.")) return;
                      await clearIntake(intake.propertyId);
                      await refresh();
                    }}
                    className="rounded border border-ink-500 px-3 py-1.5 text-xs text-mist-400"
                  >
                    Forget
                  </button>
                </div>
              </div>
            ))}
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
                {row.rooms} rooms &middot;{" "}
                {row.nodes === 0
                  ? "built without photos"
                  : `built from ${row.nodes} ${row.nodes === 1 ? "photo" : "photos"}`}
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
