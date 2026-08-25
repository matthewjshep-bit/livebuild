import { adminConfigured, serviceClient } from "@/lib/cloud/server";

/**
 * Whether publishing is available, without revealing anything about how.
 *
 * The UI needs to know if a Publish button makes sense at all. Returning the
 * two booleans separately lets it say something useful - "storage is set up but
 * no admin key" is a different fix from "no Supabase project" - while telling
 * an anonymous caller nothing beyond the fact that the feature exists.
 */
export async function GET() {
  return Response.json({
    storage: Boolean(serviceClient()),
    admin: adminConfigured(),
  });
}
