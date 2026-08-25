"use client";

import { useEffect, useState } from "react";

import { fetchListingPhoto, lookupListing } from "@/lib/listing/client";
import type { ListingResult } from "@/lib/listing/types";
import { addressFromZillowUrl, looksLikeUrl } from "@/lib/listing/url";

/**
 * The front door: an address or a listing link.
 *
 * Photos used to be the way in, and asking for them first was asking for the
 * one thing the user has to go and find. Almost everything the build needs is
 * already published against the address - the photographs, the bed and bath
 * counts, the square footage, and the building's real outline - so the address
 * is the smaller question and it produces more.
 *
 * This never hides itself. The scraper needs a paid token and the outline needs
 * nothing at all, so an unconfigured deployment still turns an address into a
 * correctly shaped, correctly oriented house; only the photographs are missing.
 * Hiding the whole field because half of it is unavailable would be throwing
 * away the half that works.
 */
export function PropertyStart({
  onImported,
  busy,
}: {
  onImported: (files: File[], listing: ListingResult) => Promise<void> | void;
  /** True while the page is doing something else, so this cannot be re-entered. */
  busy?: boolean;
}) {
  const [photosAvailable, setPhotosAvailable] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/listing")
      .then((r) => r.json())
      .then((d) => setPhotosAvailable(Boolean(d.photos ?? d.available)))
      .catch(() => setPhotosAvailable(false));
  }, []);

  // Naming the property back to the user the moment a link is pasted, so it is
  // obvious the right house was understood before anything slow begins.
  const pastedAddress = looksLikeUrl(query) ? addressFromZillowUrl(query) : null;

  const run = async () => {
    setError(null);
    setStage(
      photosAvailable
        ? "Looking up the listing… this can take a couple of minutes"
        : "Finding the building on the map…",
    );

    try {
      const listing = await lookupListing(query);

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

      // No photographs is a workable outcome rather than a failure, so long as
      // something was learned. The outline alone builds a house of the right
      // shape; only the walk-through needs pictures.
      const learnedNothing =
        files.length === 0 && !listing.footprint && !listing.facts.sqft && !listing.facts.beds;
      if (learnedNothing) {
        setError(
          "That address was found, but nothing is published about the building - no outline on the map and no listing details. You can still add photos below, or describe the house.",
        );
      }

      setStage(files.length > 0 ? `Saving ${files.length} photos` : "Reading the building");
      await onImported(files, listing);
      setStage(null);
      setQuery("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed.");
      setStage(null);
    }
  };

  const working = stage !== null || busy === true;

  return (
    <div className="mx-auto max-w-2xl">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={working}
          aria-label="Property address or listing link"
          placeholder="123 Main St, Seattle, WA 98101 — or paste a Zillow link"
          className="min-w-0 flex-1 rounded-lg border border-ink-600 bg-ink-800 px-3.5 py-3 text-sm outline-none focus:border-accent-dim disabled:opacity-50"
        />
        <button
          disabled={working || query.trim().length < 6}
          className="shrink-0 rounded-lg bg-accent px-6 py-3 text-sm font-semibold text-ink-900 disabled:opacity-35"
        >
          {working ? "Working…" : "Build it"}
        </button>
      </form>

      {pastedAddress && !stage && (
        <p className="mt-2 text-xs text-mist-400">
          Reading that as <span className="text-mist-200">{pastedAddress}</span>
        </p>
      )}

      {stage && <p className="mt-2 text-xs text-mist-400">{stage}</p>}
      {error && <p className="mt-2 text-xs text-warn">{error}</p>}

      {photosAvailable === false && !stage && (
        <p className="mt-2 text-xs text-mist-400">
          Listing photos are not configured here, so this will build the house from its
          outline on the map &ndash; the right shape and the right way round. Add your own
          photos below to fill it in.
        </p>
      )}
    </div>
  );
}
