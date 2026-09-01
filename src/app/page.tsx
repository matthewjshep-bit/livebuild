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

/** What the house is built from, for the strip under the headline. */
const SOURCES = ["listing photos", "satellite", "street view", "the map"];

const CLAIMS = [
  {
    title: "Built, not projected",
    body: "Nothing is handed back to you as a photograph. The pictures are read, and what they describe gets built - so the camera is free to move.",
  },
  {
    title: "No special hardware",
    body: "No depth-sensing rig, no per-scan fee, no site visit. If the house has been photographed and it sits on the map, it can be built.",
  },
  {
    title: "Priced as it is built",
    body: "Every surface is geometry with a material on it, so the scope and the costs fall straight out of the model rather than being estimated beside it.",
  },
];

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
    <main className="relative min-h-full overflow-hidden">
      {/* Painted backdrop. `fixed` and behind everything, so the light stays
          put while the page scrolls rather than sliding off the top. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 accent-wash" />
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 grid-wash" />

      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <Wordmark />
        <nav className="flex items-center gap-1 text-sm">
          <a
            href="/storage"
            className="hidden rounded-lg px-3 py-2 text-mist-400 transition hover:text-mist-200 sm:block"
          >
            Storage
          </a>
          <a
            href="#builds"
            className="hidden rounded-lg px-3 py-2 text-mist-400 transition hover:text-mist-200 sm:block"
          >
            Your builds
          </a>
          <a
            href="/new"
            className="rounded-lg bg-accent px-4 py-2 font-medium text-ink-900 transition hover:brightness-110"
          >
            Start a build
          </a>
        </nav>
      </header>

      <section className="mx-auto max-w-5xl px-6 pb-20 pt-14 text-center sm:pt-24">
        <p
          className="rise inline-flex items-center gap-2 rounded-full border border-ink-600 bg-ink-800/60 px-3 py-1 text-xs text-mist-400"
          style={{ animationDelay: "0ms" }}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          No depth camera &middot; no per-scan fee &middot; no site visit
        </p>

        <h1
          className="rise mx-auto mt-6 max-w-3xl text-balance text-4xl font-semibold leading-[1.08] tracking-tight sm:text-6xl"
          style={{ animationDelay: "60ms" }}
        >
          <span className="ink-gradient">Photographs in.</span>
          <br />
          <span className="accent-gradient">A house you can walk out.</span>
        </h1>

        <p
          className="rise mx-auto mt-6 max-w-xl text-pretty text-base leading-relaxed text-mist-400"
          style={{ animationDelay: "120ms" }}
        >
          Livebuild.ai reads the photographs, the satellite imagery and the map,
          then builds the house itself - a hyper-realistic 3D replica you can
          walk through, take apart, price and send to anyone.
        </p>

        <div
          className="rise mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
          style={{ animationDelay: "180ms" }}
        >
          <a
            href="/new"
            className="group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-6 py-3.5 text-base font-semibold text-ink-900 shadow-lg shadow-accent/20 transition hover:brightness-110 sm:w-auto"
          >
            Start a build
            <span className="transition-transform group-hover:translate-x-0.5">&rarr;</span>
          </a>
          <a
            href="/tour/demo-house"
            className="inline-flex w-full items-center justify-center rounded-xl border border-ink-500 px-6 py-3.5 text-base text-mist-200 transition hover:border-mist-400 sm:w-auto"
          >
            Walk a sample house
          </a>
        </div>

        {/* The pipeline, said once in the shape it actually has: many kinds of
            evidence in, one model out. */}
        <div
          className="rise mt-14 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs text-mist-400"
          style={{ animationDelay: "240ms" }}
        >
          {SOURCES.map((source) => (
            <span
              key={source}
              className="rounded-md border border-ink-600 bg-ink-800/50 px-2.5 py-1"
            >
              {source}
            </span>
          ))}
          <span className="px-1 text-ink-500">&rarr;</span>
          <span className="rounded-md border border-ink-600 bg-ink-800/50 px-2.5 py-1">
            read
          </span>
          <span className="px-1 text-ink-500">&rarr;</span>
          <span className="rounded-md border border-accent-dim bg-accent/10 px-2.5 py-1 text-accent">
            one model you can walk, price and share
          </span>
        </div>
      </section>

      <section className="mx-auto grid max-w-5xl gap-3 px-6 pb-24 sm:grid-cols-3">
        {CLAIMS.map((claim) => (
          <div
            key={claim.title}
            className="rounded-xl border border-ink-600 bg-ink-800/40 p-5 transition hover:border-ink-500"
          >
            <h3 className="text-sm font-semibold text-mist-200">{claim.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-mist-400">{claim.body}</p>
          </div>
        ))}
      </section>

      {/* ------------------------------------------------------------------
          Everything below is the working app: the builds in this browser and
          the tours that have been published from it.
          ------------------------------------------------------------------ */}
      <section
        id="builds"
        className="mx-auto max-w-5xl scroll-mt-6 border-t border-ink-700 px-6 py-14"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-mist-200">
              Your builds
            </h2>
            <p className="mt-1 text-sm text-mist-400">
              Saved in this browser. Publish one to open it anywhere.
            </p>
          </div>
          <a
            href="/new"
            className="rounded-lg border border-ink-500 px-4 py-2 text-sm text-mist-200 transition hover:border-accent hover:text-accent"
          >
            + New build
          </a>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="flex flex-col justify-between gap-4 rounded-xl border border-ink-600 bg-ink-800/60 p-4 transition hover:border-ink-500"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="text-base font-medium text-mist-200">{entry.label}</div>
                  {entry.bundled && (
                    <span className="shrink-0 rounded border border-ink-600 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-mist-400">
                      sample
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-mist-400">
                  {entry.importing ? (
                    <span className="text-accent">
                      still importing &middot; {entry.photos} photo
                      {entry.photos === 1 ? "" : "s"}
                    </span>
                  ) : (
                    <>
                      {entry.rooms} rooms &middot; {entry.nodes} viewpoints
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
                  className="self-start rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-ink-900"
                >
                  Continue building
                </a>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <a
                    href={`/tour/${entry.id}`}
                    className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-ink-900 transition hover:brightness-110"
                  >
                    Open tour
                  </a>
                  <a
                    href={`/bom/${entry.id}`}
                    className="rounded-lg border border-ink-500 px-3 py-1.5 text-xs transition hover:border-mist-400"
                  >
                    Scope &amp; costs
                  </a>
                  <a
                    href={`/editor?id=${entry.id}`}
                    className="rounded-lg border border-ink-500 px-3 py-1.5 text-xs transition hover:border-mist-400"
                  >
                    Edit
                  </a>
                </div>
              )}
            </div>
          ))}

          {entries.length === 0 && (
            <a
              href="/new"
              className="rounded-xl border border-dashed border-ink-600 px-4 py-10 text-center text-sm text-mist-400 transition hover:border-accent hover:text-accent sm:col-span-2"
            >
              Nothing here yet. Start your first build &rarr;
            </a>
          )}
        </div>
      </section>

      {published && published.length > 0 && (
        <section className="mx-auto max-w-5xl border-t border-ink-700 px-6 py-14">
          <h2 className="text-xl font-semibold tracking-tight text-mist-200">
            Published
          </h2>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-mist-400">
            Live on the web at an unguessable link, from any machine that published
            one. Anybody with the link can open it; nobody can find it without.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {published.map((tour) => (
              <div
                key={tour.slug}
                className="flex items-center justify-between gap-3 rounded-xl border border-ink-600 bg-ink-800/60 p-4 transition hover:border-ink-500"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-mist-200">
                    {tour.label || "Untitled"}
                  </div>
                  <div className="truncate text-xs text-mist-400">
                    {tour.photo_count} photo{tour.photo_count === 1 ? "" : "s"} &middot;{" "}
                    {new Date(tour.updated_at).toLocaleDateString()} &middot;{" "}
                    <span className="font-mono">/t/{tour.slug}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <a
                    href={`/t/${tour.slug}`}
                    className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-ink-900 transition hover:brightness-110"
                  >
                    Open
                  </a>
                  <button
                    onClick={() => {
                      void navigator.clipboard?.writeText(
                        `${window.location.origin}/t/${tour.slug}`,
                      );
                    }}
                    className="rounded-lg border border-ink-500 px-3 py-1.5 text-xs transition hover:border-mist-400"
                  >
                    Copy link
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <footer className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 border-t border-ink-700 px-6 py-8 text-xs text-mist-400">
        <Wordmark small />
        <div className="flex flex-wrap gap-4">
          <a href="/storage" className="underline underline-offset-4 hover:text-mist-200">
            Storage &amp; backups
          </a>
          <a href="/editor" className="underline underline-offset-4 hover:text-mist-200">
            Advanced: place rooms manually
          </a>
        </div>
      </footer>
    </main>
  );
}

/**
 * The wordmark, in one place so the header and the footer cannot drift apart.
 *
 * The `.ai` is set in the accent and the rest in plain ink, which is what makes
 * it read as a name rather than as a heading that happens to be at the top.
 */
function Wordmark({ small = false }: { small?: boolean }) {
  return (
    <a
      href="/"
      className={`font-semibold tracking-tight text-mist-200 ${small ? "text-sm" : "text-lg"}`}
    >
      Livebuild<span className="text-accent">.ai</span>
    </a>
  );
}
