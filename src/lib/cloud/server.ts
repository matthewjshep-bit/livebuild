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

/**
 * Read at call time, not when the module loads.
 *
 * Module-scope `process.env` is captured once, whenever the module is first
 * evaluated - which on a serverless platform can be during the build rather
 * than during a request. A value that was not set at that moment is then frozen
 * as empty for the life of the deployment, and the symptom is a deployment that
 * reports itself unconfigured no matter what the dashboard says. Reading inside
 * the function costs nothing and cannot be stale.
 */
/**
 * Trimmed, because a dashboard field will happily hold a trailing newline and
 * then show you nothing to distinguish it from a clean one. `isAdmin` compares
 * lengths before anything else, so one invisible character rejects the correct
 * passphrase - and the operator has no way to see why.
 */
const serviceRoleKey = () => (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
const adminKey = () => (process.env.MATTERMATT_ADMIN_KEY ?? "").trim();

export function serviceClient() {
  const key = serviceRoleKey();
  if (!SUPABASE_URL || !key) return null;
  return createClient(SUPABASE_URL, key, {
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
  const expected = adminKey();
  if (!expected || !provided) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

export function adminConfigured(): boolean {
  return Boolean(adminKey());
}
