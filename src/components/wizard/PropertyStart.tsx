"use client";

import { useEffect, useState } from "react";

import { fetchListingPhotos, lookupListing } from "@/lib/listing/client";
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
  /**
   * What the last lookup came back with, for the address currently in the box.
   *
   * Both halves of the answer matter to what is said next. Locating the house
   * and finding a drawn building are separate outcomes, and OpenStreetMap
   * frequently has the first without the second - so saying "found the
   * building, its outline and which way it faces" for a house nobody has
   * mapped would be claiming something that did not happen.
   */
  const [found, setFound] = useState<
    { mode: "outline" | "full"; located: boolean; outlined: boolean } | null
  >(null);

  useEffect(() => {
    fetch("/api/listing")
      .then((r) => r.json())
      .then((d) => setPhotosAvailable(Boolean(d.photos ?? d.available)))
      .catch(() => setPhotosAvailable(false));
  }, []);

  // Naming the property back to the user the moment a link is pasted, so it is
  // obvious the right house was understood before anything slow begins.
  const pastedAddress = looksLikeUrl(query) ? addressFromZillowUrl(query) : null;

  /**
   * Find the building, and optionally pull the listing with it.
   *
   * `outline` is the default because it is seconds and free, and because the
   * address is often not where the photographs are coming from. Typing where
   * the house is used to cost a multi-minute scrape even when the pictures were
   * already in hand, which made recording the address feel expensive.
   */
  const run = async (mode: "outline" | "full") => {
    setError(null);
    setStage(
      mode === "full"
        ? "Looking up the listing… this can take a couple of minutes"
        : "Finding the building on the map…",
    );

    try {
      const listing = await lookupListing(query, mode);

      // A few at a time, each with a deadline. One unreachable photograph should
      // cost that photograph and nothing else - and before there was a deadline
      // it could cost the whole build, stalling on one image behind a progress
      // bar that never moved.
      const downloaded = await fetchListingPhotos(listing.photos, (done, total) =>
        setStage(`Downloading photo ${done} of ${total}`),
      );
      const files = downloaded.map(
        ({ index, blob }) =>
          new File([blob], `listing-${String(index + 1).padStart(2, "0")}.jpg`, {
            type: blob.type || "image/jpeg",
          }),
      );
      const missed = listing.photos.length - files.length;

      // No photographs is a workable outcome rather than a failure, so long as
      // something was learned. The outline alone builds a house of the right
      // shape; only the walk-through needs pictures.
      const learnedNothing =
        files.length === 0 &&
        !listing.footprint &&
        !listing.facts.sqft &&
        !listing.facts.beds &&
        !listing.location;
      if (learnedNothing) {
        // Say which thing failed. The old message ran three unrelated causes
        // together - an unconfigured scraper, an address the map has never
        // heard of, and a building nobody has drawn - and the user can act on
        // the first two.
        const outline =
          listing.footprintMiss === "not-located"
            ? "That address is not on the map. Rural roads are often missing from OpenStreetMap, so there is no outline to build from."
            : listing.footprintMiss === "lookup-failed"
              ? "The map service did not answer just now. Trying again often works."
              : "The address was located, but no building is drawn there on the map.";

        const details =
          mode === "outline"
            ? ""
            : listing.scraperConfigured === false
              ? " Listing lookup is not configured on this deployment, so no photos or room counts could be fetched either — set APIFY_TOKEN to enable it."
              : " The listing had no details either.";

        setError(`${outline}${details} You can still add photos below, or describe the house.`);
      }

      if (missed > 0 && files.length > 0) {
        setError(
          `${missed} of ${listing.photos.length} photos would not download and ${missed === 1 ? "was" : "were"} skipped. You can add ${missed === 1 ? "it" : "them"} by hand, or try again.`,
        );
      }

      setStage(files.length > 0 ? `Saving ${files.length} photos` : "Reading the building");
      await onImported(files, listing);
      setStage(null);
      // The address stays put. It is the name of the house being worked on, and
      // clearing it made the field look like it had forgotten.
      setFound({
        mode,
        located: Boolean(listing.location),
        outlined: Boolean(listing.footprint),
      });
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
          /**
           * A pasted listing link asks for the listing.
           *
           * The cheap lookup is the right default for a typed address - it is
           * seconds and free, and somebody who already has the photographs
           * should not pay a multi-minute scrape to record where the house is.
           * A URL is not that. Somebody who pastes a listing has handed over
           * the one thing that knows this property's own rooftop coordinates,
           * its floor area and its photographs, and running the map-only half
           * on it throws all three away - then builds a house from a geocode
           * that, for the address this was found on, landed in the middle of
           * the road with a neighbour's roof nearer than its own.
           */
          void run(looksLikeUrl(query) ? "full" : "outline");
        }}
      >
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setFound(null);
          }}
          disabled={working}
          aria-label="Property address or listing link"
          placeholder="123 Main St, Seattle, WA 98101 — or paste a Zillow link"
          className="min-w-0 flex-1 rounded-lg border border-ink-600 bg-ink-800 px-3.5 py-3 text-sm outline-none focus:border-accent-dim disabled:opacity-50"
        />
        <button
          disabled={working || query.trim().length < 6}
          className="shrink-0 rounded-lg bg-accent px-6 py-3 text-sm font-semibold text-ink-900 disabled:opacity-35"
        >
          {working ? "Working…" : looksLikeUrl(query) ? "Get the listing" : "Find it"}
        </button>
      </form>

      {/* The expensive half, asked for rather than assumed.
          Only offered once the address has been located, and only where a
          scraper is configured - it is minutes of waiting and forty downloads,
          which is the wrong default for somebody who already has the photos. */}
      {found?.located && photosAvailable && found.mode === "outline" && !working && (
        <button
          onClick={() => void run("full")}
          className={`mt-2 w-full rounded-lg px-4 py-2.5 text-xs transition ${
            found.outlined
              ? "border border-ink-500 text-mist-200 hover:bg-ink-600"
              : "bg-accent font-semibold text-ink-900 hover:bg-accent/90"
          }`}
        >
          {found.outlined ? (
            <>
              Also pull the photos and room counts from the listing
              <span className="ml-1 text-mist-400">&mdash; a couple of minutes</span>
            </>
          ) : (
            <>
              Pull the listing to place this house properly
              <span className="ml-1 opacity-70">&mdash; a couple of minutes</span>
            </>
          )}
        </button>
      )}

      {pastedAddress && !stage && (
        <p className="mt-2 text-xs text-mist-400">
          Reading that as <span className="text-mist-200">{pastedAddress}</span>
        </p>
      )}

      {stage && <p className="mt-2 text-xs text-mist-400">{stage}</p>}
      {error && <p className="mt-2 text-xs text-warn">{error}</p>}

      {found?.mode === "outline" && found.located && !working && (
        <p className="mt-2 text-xs text-mist-400">
          {found.outlined
            ? "Found the building, its outline and which way it faces. Add photographs below to fill it in."
            : "Found where it is, but no building is drawn there on the map, so the outline has to be read off the satellite image — and an address can geocode to the kerb or a driveway, which is how a neighbour's roof gets traced instead. The listing carries this house's own position and floor area, which fixes both."}
        </p>
      )}

      {photosAvailable === false && !stage && (
        <p className="mt-2 text-xs text-mist-400">
          Listing photos are not configured here, so this builds the house from its outline
          on the map &ndash; the right shape and the right way round. Add your own photos
          below to fill it in.
        </p>
      )}
    </div>
  );
}
