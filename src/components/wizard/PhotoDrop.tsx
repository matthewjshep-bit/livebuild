"use client";

import { useCallback, useRef, useState } from "react";

import { type ImportedFile, importImage, refusedMessage } from "@/lib/photos/decode";

export type ImportedPhoto = {
  id: string;
  name: string;
  /**
   * The original file, present only in the session that imported it. A `File`
   * handle does not survive a reload, so a resumed draft has none and must work
   * from `ref` instead.
   */
  file: File | null;
  /** `idb:` reference to the stored blob. Always present. */
  ref: string;
  url: string;
  roomLabel: string | null;
  /**
   * Set when the label came from the vision pass rather than the user, so a
   * low-confidence guess can be flagged for review. Absent means hand-set.
   */
  guessed?: "high" | "low";
};



/**
 * Step one: photos.
 *
 * Everything here starts from the photos rather than from a floor plan,
 * because that is the order the user actually has things in. They have a folder
 * of listing shots; they do not have a drawing of the house, and asking for one
 * first is what made the old editor feel like CAD.
 */
export function PhotoDrop({
  photos,
  onAdd,
  onRemove,
  onProblem,
}: {
  photos: ImportedPhoto[];
  onAdd: (files: File[]) => Promise<void> | void;
  onRemove: (id: string) => void;
  /**
   * Files that could not be read, handed up rather than drawn here.
   *
   * The drop zone lives inside a `<details>` that is open only while there are
   * photos, so a notice rendered here appears exactly when nobody can see it -
   * the first import is the one that has none yet, and it is also the one most
   * likely to be a folder of HEICs.
   */
  onProblem?: (message: string | null) => void;
  /** Photos plus the listing facts that came with them. */
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState(false);

  const accept = useCallback(
    async (list: FileList | null) => {
      if (!list || list.length === 0) return;
      /**
       * Copied out of the `FileList` before anything is awaited.
       *
       * The input's `onChange` clears `e.target.value` on the line after it
       * calls this, which empties the list it was handed. The old code spread
       * it into an array on its first line and so never noticed; reading it
       * across an await instead means the first file is imported and every one
       * after it silently is not - two photos in, one photo out, no error
       * anywhere. `[...list]` was load-bearing.
       */
      const files = [...list];
      onProblem?.(null);

      // Importing decodes, scales and re-encodes every file, which takes a
      // moment for a full set - so say so rather than appearing to have
      // ignored the drop.
      setBusy(true);
      try {
        /**
         * Decoded here, not filtered by MIME type.
         *
         * The type is a hint: a macOS picker sometimes reports none at all, and
         * `image/heic` is a perfectly good type for a file this browser still
         * cannot open. Whether the image decodes is the only question that
         * matters, and it is answered by trying.
         */
        const results: ImportedFile[] = [];
        for (const file of files) results.push(await importImage(file));

        const usable = results.flatMap((r) => (r.ok ? [r.file] : []));
        onProblem?.(refusedMessage(results));
        if (usable.length > 0) await onAdd(usable);
      } finally {
        setBusy(false);
      }
    },
    [onAdd, onProblem],
  );

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          accept(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`grid cursor-pointer place-items-center rounded-xl border-2 border-dashed px-6 py-14 text-center transition ${
          dragging
            ? "border-accent bg-accent/10"
            : "border-ink-500 bg-ink-800 hover:border-accent-dim"
        }`}
      >
        <div className="space-y-2">
          <div className="text-4xl">{busy ? "💾" : "🏠"}</div>
          <p className="text-lg font-medium text-mist-200">Drop your house photos here</p>
          <p className="text-sm text-mist-400">
            Every room you want in the tour. 20&ndash;30 photos is typical.
          </p>
          <p className="text-xs text-mist-400">
            {busy ? "Reading photos…" : "or click to choose files"}
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          /**
           * The extensions as well as the wildcard.
           *
           * `image/*` alone leaves the Open button greyed out when somebody
           * picks from the Photos source of the macOS panel: the panel allows
           * what the browser told it to allow, and the browser's expansion of
           * the wildcard does not include `public.heic`. So the photographs are
           * visible, selectable, and cannot be opened - with nothing on screen
           * saying why.
           *
           * Naming them lets the selection through. Whether the browser can
           * then *read* one is a separate question, answered on import and
           * reported there.
           */
          accept="image/*,.heic,.heif,.HEIC,.HEIF"
          multiple
          hidden
          onChange={(e) => {
            void accept(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {photos.length > 0 && (
        <>
          <p className="mt-6 text-sm text-mist-400">
            {photos.length} photo{photos.length === 1 ? "" : "s"} saved &ndash; safe to close
            this tab and come back
          </p>
          <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-6">
            {photos.map((photo) => (
              <div key={photo.id} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.url}
                  alt={photo.name}
                  data-testid="photo-thumb"
                  className="aspect-4/3 w-full rounded object-cover"
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(photo.id);
                  }}
                  className="absolute top-1 right-1 hidden h-5 w-5 rounded-full bg-ink-900/85 text-xs leading-none text-mist-200 group-hover:block"
                  aria-label={`Remove ${photo.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
