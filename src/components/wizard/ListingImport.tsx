"use client";

import { useEffect, useState } from "react";

import { fetchListingPhoto, lookupListing } from "@/lib/listing/client";
import type { ListingResult } from "@/lib/listing/types";

/**
 * Import a listing by address instead of dragging files in.
 *
 * Pulls the photos and, more usefully, the facts: beds, baths, square footage
 * and the agent's remarks. The square footage is what makes the generated plan
 * true to size rather than merely plausible.
 *
 * Hidden entirely when no Apify token is configured, rather than offered as a
 * button that fails.
 */
export function ListingImport({
  onImported,
}: {
  onImported: (files: File[], listing: ListingResult) => Promise<void> | void;
}) {
  const [available, setAvailable] = useState(false);
  const [address, setAddress] = useState("");
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/listing")
      .then((r) => r.json())
      .then((d) => setAvailable(Boolean(d.available)))
      .catch(() => setAvailable(false));
  }, []);

  if (!available) return null;

  const run = async () => {
    setError(null);
    setStage("Looking up the listing… this can take a couple of minutes");

    try {
      const listing = await lookupListing(address);
      if (listing.photos.length === 0) {
        setError("That listing had no photos.");
        setStage(null);
        return;
      }

      const files: File[] = [];
      for (let i = 0; i < listing.photos.length; i++) {
        setStage(`Downloading photo ${i + 1} of ${listing.photos.length}`);
        try {
          const blob = await fetchListingPhoto(listing.photos[i]);
          files.push(
            new File([blob], `listing-${String(i + 1).padStart(2, "0")}.jpg`, {
              type: blob.type || "image/jpeg",
            }),
          );
        } catch {
          // One unreachable photo should not cost the other thirty-nine.
        }
      }

      if (files.length === 0) {
        setError("The listing was found but its photos could not be downloaded.");
        setStage(null);
        return;
      }

      setStage(`Saving ${files.length} photos`);
      await onImported(files, listing);
      setStage(null);
      setAddress("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
      setStage(null);
    }
  };

  const busy = stage !== null;

  return (
    <div className="mt-5 rounded-lg border border-ink-600 bg-ink-800 p-4">
      <h3 className="text-sm font-medium">Or pull it from a listing</h3>
      <p className="mt-1 text-xs leading-relaxed text-mist-400">
        Photos, bedroom and bathroom counts, and square footage &ndash; which is what makes
        the floor plan come out the right size rather than a generic one.
      </p>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          disabled={busy}
          placeholder="123 Main St, Seattle, WA 98101"
          className="min-w-0 flex-1 rounded border border-ink-600 bg-ink-700 px-2.5 py-1.5 text-sm outline-none focus:border-accent-dim disabled:opacity-50"
        />
        <button
          disabled={busy || address.trim().length < 6}
          className="shrink-0 rounded bg-accent px-4 py-1.5 text-xs font-medium text-ink-900 disabled:opacity-35"
        >
          {busy ? "Working…" : "Import"}
        </button>
      </form>

      {stage && <p className="mt-2 text-xs text-mist-400">{stage}</p>}
      {error && <p className="mt-2 text-xs text-warn">{error}</p>}
    </div>
  );
}
