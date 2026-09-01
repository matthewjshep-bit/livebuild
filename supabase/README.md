# Supabase setup

Ten minutes, once.

1. **Create a project** at supabase.com. Any region near you; note the database
   password somewhere safe (you will not need it for this app).

2. **Run the schema.** Dashboard → SQL Editor → New query → paste `schema.sql`
   → Run.

3. **Create the storage bucket.** Dashboard → Storage → New bucket:
   - Name: `tours`
   - **Public bucket: on** — tour photos are served directly to viewers, and a
     public bucket means no signed URL per image on every page load.

4. **Copy three values** from Dashboard → Project Settings → API into
   `.env.local` (and later into Vercel):

   | Value | Env var | Safe in the browser? |
   |---|---|---|
   | Project URL | `NEXT_PUBLIC_SUPABASE_URL` | yes |
   | `anon` `public` key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes — read-only under RLS |
   | `service_role` key | `SUPABASE_SERVICE_ROLE_KEY` | **no — server only** |

   The service-role key bypasses row-level security entirely. It must never
   appear in client code or in any `NEXT_PUBLIC_*` variable. In this app it is
   read only inside `src/app/api/publish/*`, which runs server-side.

5. **Set an admin passphrase** — `LIVEBUILD_ADMIN_KEY`. Publishing asks for it
   once and remembers it in your browser. This is a publish gate for a single
   person, not user accounts: it stops strangers filling your storage. If this
   ever becomes multi-agent, replace it with Supabase Auth and per-user rows.

## What gets stored

```
tours/<slug>/photos/<node>.jpg    downscaled to 1600px on publish
tours/<slug>/depth/<node>.png     depth maps, lossless (they carry numbers)
```

Photos are downscaled before upload because the raw set is ~90MB per house and
the free tier is 1GB. At 1600px they land around 300KB each, so a house is
roughly 8–12MB.

## Free tier limits

500MB database, 1GB storage, 5GB egress per month. The database rows are
kilobytes; storage is the constraint — roughly 80–120 published houses.
