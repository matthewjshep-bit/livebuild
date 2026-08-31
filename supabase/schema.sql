-- MatterMatt — Supabase schema
--
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
--
-- The security model is deliberately lopsided: nobody may write a tour, and a
-- tour is readable only by its exact slug. Writes happen only through the
-- service-role key, which lives in Vercel's environment and never reaches a
-- browser. That way a leaked anon key cannot be used to overwrite or delete a
-- tour - nor, now, to read one.

create table if not exists tours (
  slug        text primary key,
  label       text not null default '',
  -- The whole property document: plan, rooms, viewpoints, media URLs.
  -- Kept as one jsonb blob because it is always read and written whole, and
  -- normalising it would buy nothing until there is something to query across.
  document    jsonb not null,
  photo_count int  not null default 0,
  bytes       bigint not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists tours_updated_at_idx on tours (updated_at desc);

alter table tours enable row level security;

-- No policies at all, for anything. Without one, RLS denies by default for the
-- anon and authenticated roles; the service role bypasses RLS entirely.
--
-- This used to carry a blanket read policy, on the reasoning that "a tour is
-- meant to be sent to a buyer, so the link is the permission - there is nothing
-- private in a published listing". The first half was right and the second was
-- an assumption that stopped being true.
--
-- `select using (true)` does not mean "readable by link". It means readable,
-- and *listable*: the anon key is inlined into the client bundle by Next, so
-- anyone who opens the site can lift it and enumerate every row - slug, label,
-- and the whole document with its condition grades and rate card. That was
-- survivable while the table held only tours somebody had chosen to publish.
-- It stopped being survivable when every build began syncing here, because the
-- table then holds every property the operator has ever looked at.
--
-- Nothing needed the policy: `/t/[slug]` renders on the server and reads
-- through the service-role client, which ignores RLS. So removing it costs
-- nothing and makes the slug genuinely the permission, which is what the
-- comment always claimed.
drop policy if exists "tours are publicly readable" on tours;

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists tours_touch_updated_at on tours;
create trigger tours_touch_updated_at
  before update on tours
  for each row execute function touch_updated_at();
