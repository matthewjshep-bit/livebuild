# Deploying to livebuild.ai

Vercel runs the app; Cloudflare keeps the domain and points at it. Supabase
holds published tours. Roughly forty minutes end to end, most of it waiting.

## 1. Get the code into GitHub

Vercel deploys from a repository, and there isn't one yet.

```bash
git init
git add -A
git commit -m "Livebuild.ai"
gh repo create livebuild-ai --private --source=. --push
```

`.gitignore` already covers `.env*`, `node_modules/`, `.next/`, `shots/` and
`pipeline/.venv/`. **Check `git status` before the first push** and confirm no
`.env.local` is listed — that file has your keys in it.

## 2. Supabase

Follow `supabase/README.md`: create the project, run `schema.sql`, create a
**public** bucket called `tours`, and copy out the three values.

## 3. Vercel

Import the GitHub repo at vercel.com/new. It detects Next.js; no build settings
to change.

Add these under Settings → Environment Variables, for **Production** and
**Preview**:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | from Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | from Supabase — **never** rename this to `NEXT_PUBLIC_*` |
| `LIVEBUILD_ADMIN_KEY` | `openssl rand -base64 32` |
| `ANTHROPIC_API_KEY` | optional, for the AI description pass |
| `GOOGLE_MAPS_API_KEY` | optional, for reading the outside of the house from Street View and satellite |
| `APIFY_TOKEN` | optional, for pulling photos and details from a Zillow listing |

Deploy. You get a `*.vercel.app` URL — confirm it works before touching DNS.

## 4. Point livebuild.ai at it

In Vercel: Settings → Domains → add `livebuild.ai` and `www.livebuild.ai`.
Vercel will show the records it wants.

In Cloudflare DNS:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `@` | `76.76.21.21` | **DNS only (grey cloud)** |
| CNAME | `www` | `cname.vercel-dns.com` | **DNS only (grey cloud)** |

> **Turn the orange cloud off.** Cloudflare's proxy in front of Vercel gives you
> two CDNs fighting over caching and TLS, and it is the usual cause of redirect
> loops and stale deploys on exactly this setup. Let Vercel serve the site.
> (Use Vercel's own values if they differ from the above — they occasionally
> change the apex IP.)

SSL in Cloudflare should be **Full (strict)**. Certificates issue within a few
minutes; propagation can take up to an hour.

## 5. Publish something

Open `livebuild.ai`, build a tour, click **Publish** in the tour header, and
paste the passphrase. You get `livebuild.ai/t/<slug>` — send that to anyone.

## What runs where

```
Browser        drafting, photos, depth estimation (WASM/WebGPU)
Vercel         the app; /api/describe; signing upload URLs
Supabase       published tours (Postgres) + their photos (Storage)
Cloudflare     DNS only
```

Photos upload **straight from the browser to Supabase** using short-lived signed
URLs. They have to: a Vercel function caps request bodies near 4.5MB and a house
is tens of megabytes.

## Two things to expect

**First-time creators download ~30MB.** The depth model is fetched from Hugging
Face on first use and cached by the browser afterwards. **Viewers never download
it** — published tours carry pre-computed depth maps.

**Free-tier storage is the real limit.** 1GB, and a published house is roughly
8–12MB after downscaling, so on the order of 80–120 houses. The database rows
are kilobytes and will not be what runs out.

## Costs

| | Free tier | When it stops being free |
|---|---|---|
| Vercel | Hobby | Commercial use technically needs Pro ($20/mo) |
| Supabase | 500MB db, 1GB storage, 5GB egress | ~100 houses, or heavy viewing |
| Anthropic | — | Pay per call; only the description step, fractions of a cent |
| Cloudflare | DNS is free | — |
