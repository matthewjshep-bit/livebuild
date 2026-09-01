"use client";

import { publishProperty } from "@/lib/cloud/publish";
import { isCloudConfigured, newSlug } from "@/lib/cloud/config";
import { loadProperty, saveProperty } from "@/lib/property-store";
import type { Property } from "@/lib/schema";

/**
 * Keeping a tour somewhere other than this browser.
 *
 * Everything is local-first and stays that way: the browser is where a tour is
 * built and where it is read from. But a tour that exists in exactly one
 * browser is one cleared cache away from gone, and it cannot be opened on the
 * phone you are standing in the house with.
 *
 * So a finished build is also sent up. The mechanism is the publish path
 * unchanged - downscale, upload the photographs, write the document - because
 * that path already solves the hard parts and a second one would drift.
 *
 * **The slug is the access control.** The tours table has no read policy at
 * all, so nothing can list it and `/t/<slug>` is the only door. That makes the
 * slug a capability, and the whole of its security is that it cannot be
 * guessed - which is why it is random rather than the address, and why it is
 * kept on the document rather than derived again each time.
 */

const KEY_STORAGE = "livebuild:admin-key";

function adminKey(): string {
  try {
    return window.localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

/**
 * Whether a sync can even be attempted.
 *
 * Needs a configured project and the operator's passphrase, which is entered
 * once and kept in this browser. No passphrase means no sync, silently - the
 * tour is still saved locally, which is what it always was.
 */
export function canSync(): boolean {
  return isCloudConfigured() && adminKey().length > 0;
}

/**
 * Why a sync is not going to happen, or null if it is.
 *
 * Split out from `canSync` because the two reasons want different words. No
 * project configured is not the operator's problem and should stay quiet; a
 * missing passphrase is one field away from working, and saying nothing would
 * make "every tour syncs automatically" quietly false on any browser where
 * nobody had yet found the publish panel inside a tour.
 */
export function syncBlocker(): "unconfigured" | "no-key" | null {
  if (!isCloudConfigured()) return "unconfigured";
  if (adminKey().length === 0) return "no-key";
  return null;
}

export type PublishedTour = {
  slug: string;
  label: string;
  photo_count: number;
  bytes: number;
  created_at: string;
  updated_at: string;
};

/**
 * Every tour published from this project, whichever machine published it.
 *
 * The counterpart to a share model built on unguessable links: the slug is the
 * access control, so nothing lists them, so a house published from a laptop
 * that has since been wiped is unreachable by anybody - including whoever made
 * it. Reads through the same passphrase that authorises publishing.
 *
 * Returns null when the passphrase is missing or refused, so a browser that has
 * never published simply shows nothing rather than an error it cannot act on.
 */
export async function listPublished(): Promise<PublishedTour[] | null> {
  if (!isCloudConfigured() || adminKey().length === 0) return null;
  try {
    const response = await fetch("/api/publish/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminKey: adminKey() }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { tours?: PublishedTour[] };
    return body.tours ?? [];
  } catch {
    return null;
  }
}

/** Remember the passphrase for this browser, so this is asked once. */
export function rememberAdminKey(key: string): void {
  try {
    window.localStorage.setItem(KEY_STORAGE, key.trim());
  } catch {
    // A browser refusing local storage is one that cannot sync. The tour is
    // still built and still saved; nothing here is worth failing over.
  }
}

export type SyncResult =
  | { ok: true; slug: string; bytes: number }
  | { ok: false; error: string };

/**
 * Send a finished tour up, and remember where it went.
 *
 * The stored document is re-read before writing the slug back, because the
 * depth pass and the condition scan are both writing to it while this runs and
 * a snapshot taken minutes ago would undo whichever landed last.
 */
export async function syncProperty(
  property: Property,
  onProgress?: (done: number, total: number) => void,
): Promise<SyncResult> {
  if (!canSync()) return { ok: false, error: "not-configured" };

  const slug = property.cloud?.slug ?? newSlug();

  const result = await publishProperty(
    property,
    adminKey(),
    (progress) => onProgress?.(progress.completed, progress.total),
    slug,
  );

  if (!result.ok) return { ok: false, error: result.error };

  const stored = loadProperty(property.id);
  if (stored) {
    saveProperty({ ...stored, cloud: { slug, syncedAt: Date.now() } });
  }

  return { ok: true, slug, bytes: result.bytes ?? 0 };
}
