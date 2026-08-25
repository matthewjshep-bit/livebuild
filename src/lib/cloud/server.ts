import "server-only";

import { createClient } from "@supabase/supabase-js";

import { BUCKET, SUPABASE_URL } from "@/lib/cloud/config";

/**
 * Server-side Supabase client, holding the service-role key.
 *
 * The service role bypasses row-level security completely, which is exactly why
 * it lives behind `server-only`: importing this from a client component is a
 * build error rather than a silent leak of write access to every browser.
 */

const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ADMIN_KEY = process.env.MATTERMATT_ADMIN_KEY ?? "";

export function serviceClient() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export { BUCKET };

/**
 * Publish gate for a single operator.
 *
 * A shared secret, not user accounts: it stops a stranger who finds the domain
 * from filling the storage bucket. Compared in constant time so the check
 * cannot be probed one character at a time, and refused outright when unset -
 * an unconfigured deployment must not be an open one.
 */
export function isAdmin(provided: string | null | undefined): boolean {
  if (!ADMIN_KEY || !provided) return false;
  if (provided.length !== ADMIN_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < ADMIN_KEY.length; i++) {
    diff |= ADMIN_KEY.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

export function adminConfigured(): boolean {
  return Boolean(ADMIN_KEY);
}
