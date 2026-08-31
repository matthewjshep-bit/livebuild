"use client";

import { useEffect, useState } from "react";

import { DriveError, fetchDrivePhotos, listDrivePhotos } from "@/lib/drive/client";

/**
 * A folder of photographs, from a link.
 *
 * This is how property photographs actually arrive - somebody emails a Drive
 * link - and the alternative was downloading thirty files to a laptop so they
 * could be dragged back in. They land in exactly the same place as a dropped
 * file, so nothing downstream knows the difference.
 *
 * Hides itself when there is no key, like every other optional capability here.
 */
export function DriveImport({
  onFiles,
  busy,
}: {
  onFiles: (files: File[]) => Promise<void> | void;
  busy?: boolean;
}) {
  const [available, setAvailable] = useState(false);
  const [url, setUrl] = useState("");
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/drive")
      .then((r) => r.json())
      .then((d) => setAvailable(Boolean(d.available)))
      .catch(() => setAvailable(false));
  }, []);

  if (!available) return null;

  const working = stage !== null || busy === true;

  const run = async () => {
    setError(null);
    setStage("Reading the folder…");
    try {
      const listed = await listDrivePhotos(url);
      if (listed.length === 0) {
        setError("No photographs in that folder.");
        setStage(null);
        return;
      }

      const files = await fetchDrivePhotos(listed, (done, total) =>
        setStage(`Downloading photo ${done} of ${total}`),
      );
      const missed = listed.length - files.length;

      setStage(`Saving ${files.length} photos`);
      await onFiles(files);
      setStage(null);
      setUrl("");

      if (missed > 0) {
        setError(
          `${missed} of ${listed.length} would not download and ${missed === 1 ? "was" : "were"} skipped.`,
        );
      }
    } catch (e) {
      // The common failure is a folder that is not shared publicly, and the
      // route says so in words the user can act on rather than a status code.
      setError(e instanceof DriveError ? e.message : "That folder could not be read.");
      setStage(null);
    }
  };

  return (
    <div className="mt-3 border-t border-ink-600 pt-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={working}
          aria-label="Google Drive folder link"
          placeholder="…or paste a Google Drive folder link"
          className="min-w-0 flex-1 rounded border border-ink-600 bg-ink-700 px-3 py-2 text-xs outline-none focus:border-accent-dim disabled:opacity-50"
        />
        <button
          disabled={working || url.trim().length < 10}
          className="shrink-0 rounded border border-ink-500 px-4 py-2 text-xs text-mist-200 disabled:opacity-35"
        >
          {working ? "Working…" : "Get them"}
        </button>
      </form>

      {stage && <p className="mt-2 text-[11px] text-mist-400">{stage}</p>}
      {error && <p className="mt-2 text-[11px] text-warn">{error}</p>}
      {!stage && !error && (
        <p className="mt-2 text-[11px] leading-relaxed text-mist-400">
          The folder has to be shared as <span className="text-mist-200">anyone with the
          link</span> &mdash; which is how a link sent to you is normally shared already.
        </p>
      )}
    </div>
  );
}
