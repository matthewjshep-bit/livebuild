-- Stop the tours table being listable.
--
-- Run this once in the Supabase SQL editor. Until it runs, anyone who opens the
-- site can lift the anon key out of the client bundle - Next inlines it, by
-- design, it is not a secret - and read every row of `tours`: slug, label, and
-- the whole document with its condition grades and rate card.
--
-- `select using (true)` was written to mean "readable by link". It does not.
-- It means readable, and listable, which is a different thing and was only ever
-- survivable while the table held tours somebody had deliberately published.
-- It stops being survivable now that every build syncs here, because the table
-- then holds every property that has been looked at.
--
-- Nothing reads this table with the anon key: /t/<slug> renders on the server
-- through the service-role client, which bypasses RLS entirely, and the browser
-- only ever touches the storage bucket via signed upload URLs. So this costs
-- nothing and makes the slug genuinely the permission.

drop policy if exists "tours are publicly readable" on tours;

-- Should come back empty.
select policyname from pg_policies where tablename = 'tours';
