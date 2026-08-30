import { SUPABASE_URL } from "@/lib/cloud/config";
import { adminConfigured, serviceClient } from "@/lib/cloud/server";

/**
 * Whether publishing is available, without revealing anything about how.
 *
 * The UI needs to know if a Publish button makes sense at all. Returning the
 * two booleans separately lets it say something useful - "storage is set up but
 * no admin key" is a different fix from "no Supabase project" - while telling
 * an anonymous caller nothing beyond the fact that the feature exists.
 *
 * `missing` was added after a deployment insisted it was unconfigured while its
 * dashboard showed every variable present. Two booleans said something was
 * wrong and nothing about which thing, and the difference between "the build
 * could not read a public variable" and "the server cannot see a secret" is the
 * difference between two completely unrelated fixes. It lists names only, never
 * values, so it says no more than the two booleans already implied.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const missing = [
    ["NEXT_PUBLIC_SUPABASE_URL", Boolean(SUPABASE_URL)],
    ["SUPABASE_SERVICE_ROLE_KEY", Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)],
    ["MATTERMATT_ADMIN_KEY", Boolean(process.env.MATTERMATT_ADMIN_KEY)],
  ]
    .filter(([, present]) => !present)
    .map(([name]) => name);

  return Response.json({
    storage: Boolean(serviceClient()),
    admin: adminConfigured(),
    missing,
  });
}
