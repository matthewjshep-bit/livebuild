-- MatterMatt — Supabase schema
--
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
--
-- The security model is deliberately lopsided: anyone may read a published
-- tour, and nobody may write one. Writes happen only through the service-role
-- key, which lives in Vercel's environment and never reaches a browser. That
-- way a leaked anon key cannot be used to overwrite or delete a tour.

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

-- Public read. A tour is meant to be sent to a buyer, so the link is the
-- permission — there is nothing private in a published listing.
drop policy if exists "tours are publicly readable" on tours;
create policy "tours are publicly readable"
  on tours for select
  using (true);

-- No insert/update/delete policies at all. Without a policy, RLS denies by
-- default for anon and authenticated roles; the service role bypasses RLS.

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
