"use client";

import { useEffect, useState } from "react";

import { type PublishProgress, publishProperty } from "@/lib/cloud/publish";
import { toSlug } from "@/lib/cloud/config";
import { loadProperty } from "@/lib/property-store";
import type { Property } from "@/lib/schema";

/**
 * Publish a local tour and get a link worth sending.
 *
 * The admin key is remembered in this browser after the first publish, because
 * being asked for a passphrase on every publish is the kind of friction that
 * stops people publishing.
 */

const KEY_STORAGE = "livebuild:admin-key";

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function PublishPanel({ property }: { property: Property }) {
  const [available, setAvailable] = useState<{ storage: boolean; admin: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [adminKey, setAdminKey] = useState("");
  // A tour that has already synced keeps the slug it went up under. Defaulting
  // to the address instead would publish a second copy of the same house at a
  // guessable link, leaving two rows that drift apart - and quietly undo the
  // reason the slug is random in the first place.
  const [slug, setSlug] = useState(
    () => property.cloud?.slug ?? toSlug(property.label || property.id),
  );
  const [progress, setProgress] = useState<PublishProgress | null>(null);
  const [result, setResult] = useState<{ url: string; bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/publish/status")
      .then((r) => r.json())
      .then(setAvailable)
      .catch(() => setAvailable({ storage: false, admin: false }));
    try {
      setAdminKey(window.localStorage.getItem(KEY_STORAGE) ?? "");
    } catch {
      /* private mode */
    }
  }, []);

  // Only local tours can be published; a published one is already there.
  const isLocal = property.nodes.some((n) => n.photo.startsWith("blob:"));
  if (!available?.storage || !isLocal) return null;

  const run = async () => {
    setError(null);
    setResult(null);

    // Publish from the stored document, not the hydrated one on screen - its
    // photo fields are object URLs, which mean nothing to anyone else.
    const stored = loadProperty(property.id);
    if (!stored) {
      setError("Could not find this tour in local storage.");
      return;
    }

    try {
      window.localStorage.setItem(KEY_STORAGE, adminKey);
    } catch {
      /* ignore */
    }

    const outcome = await publishProperty(stored, adminKey, setProgress, slug);
    setProgress(null);

    if (outcome.ok) {
      setResult({ url: outcome.url, bytes: outcome.bytes });
    } else {
      setError(
        outcome.error === "unauthorised"
          ? "That passphrase was not accepted."
          : outcome.error === "not-configured"
            ? "Storage is not configured on this deployment."
            : `${outcome.error}${outcome.detail ? ` — ${outcome.detail}` : ""}`,
      );
    }
  };

  const busy = progress !== null && progress.stage !== "done";
  const shareUrl = result ? `${window.location.origin}${result.url}` : "";

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded border border-ink-500 px-3 py-1 text-xs text-mist-200 transition hover:bg-ink-600"
      >
        Publish
      </button>
    );
  }

  return (
    <div
      data-publish-panel
      className="absolute top-12 right-3 z-10 w-80 rounded-lg border border-ink-600 bg-ink-800/97 p-4 backdrop-blur"
    >
      <div className="flex items-start justify-between">
        <h3 className="text-sm font-medium">Publish this tour</h3>
        <button
          onClick={() => setOpen(false)}
          className="text-xs text-mist-400 hover:text-mist-200"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {result ? (
        <div className="mt-3">
          <p className="text-xs text-mist-400">
            Live. Anyone with this link can walk through it — no account needed.
          </p>
          <div className="mt-2 flex gap-1.5">
            <input
              readOnly
              aria-label="Share link"
              value={shareUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded border border-ink-600 bg-ink-700 px-2 py-1 text-xs outline-none"
            />
            <button
              onClick={() => {
                void navigator.clipboard.writeText(shareUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              }}
              className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-ink-900"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <a
            href={result.url}
            className="mt-2 inline-block text-xs text-accent underline underline-offset-4"
          >
            Open it
          </a>
          <p className="mt-2 text-[11px] text-mist-400">
            {formatBytes(result.bytes)} uploaded
          </p>
        </div>
      ) : (
        <>
          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-mist-400">
              Link
            </span>
            <div className="flex items-center gap-1 text-xs text-mist-400">
              <span>/t/</span>
              <input
                value={slug}
                aria-label="Link"
                onChange={(e) => setSlug(toSlug(e.target.value))}
                className="min-w-0 flex-1 rounded border border-ink-600 bg-ink-700 px-2 py-1 text-mist-200 outline-none focus:border-accent-dim"
              />
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-mist-400">
              The link is the only way in &ndash; nothing lists what is published.
              A random one cannot be found by guessing an address; a memorable
              one can.
            </p>
          </label>

          {available.admin && (
            <label className="mt-2 block">
              <span className="mb-1 block text-[11px] uppercase tracking-wide text-mist-400">
                Publish passphrase
              </span>
              <input
                type="password"
                aria-label="Publish passphrase"
                value={adminKey}
                onChange={(e) => setAdminKey(e.target.value)}
                className="w-full rounded border border-ink-600 bg-ink-700 px-2 py-1 text-xs outline-none focus:border-accent-dim"
              />
            </label>
          )}

          <p className="mt-2 text-[11px] leading-relaxed text-mist-400">
            Photos are shrunk to 1600px before upload. They travel as the evidence the
            model was built from, and are never drawn in it.
          </p>

          <button
            onClick={() => void run()}
            disabled={busy || !slug}
            className="mt-3 w-full rounded bg-accent px-3 py-2 text-xs font-medium text-ink-900 disabled:opacity-40"
          >
            {busy
              ? progress?.stage === "preparing"
                ? "Preparing…"
                : progress?.stage === "recording"
                  ? "Finishing…"
                  : `Uploading ${progress?.completed}/${progress?.total}…`
              : "Publish"}
          </button>

          {busy && progress && progress.total > 0 && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink-600">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${(progress.completed / progress.total) * 100}%` }}
              />
            </div>
          )}

          {error && <p className="mt-2 text-[11px] text-warn">{error}</p>}
        </>
      )}
    </div>
  );
}
