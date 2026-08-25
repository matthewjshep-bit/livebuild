# Reference only — not built, not imported

Lifted from the prvt-reviews wholesaling repo as source material. Nothing here
is part of the app; it sits outside `src/` so Next.js never compiles it.

## What was actually taken

`fetchZillowPhotos` from `rehab-scan.reference.js`, reimplemented in TypeScript
as `src/lib/listing/zillow.ts`. It returns photo URLs plus beds / baths / sqft /
yearBuilt and the listing remarks, which is precisely what the wizard needs.

The prompt discipline was taken too, if not the prompt: both rails in the
original are load-bearing rather than cruft, and the same failure modes apply to
classifying rooms. Ours keeps the equivalents — a hard instruction not to invent
what is not visible, and a conservative default when a photo is ambiguous.

## What was deliberately left

`rehab-catalog.reference.js` is Seattle-market, mid-grade flip pricing keyed to
a 1,500 sqft baseline. `scanRehabFromPhotos` and `gradeCompConditions` grade
condition and estimate rehab cost.

None of that bears on rendering geometry. Copying it in would have meant
maintaining someone else's pricing model to gain nothing — and it would have
gone stale immediately, since the source repo keeps `shared/` as its single
source of truth and syncs vendored copies from it.

If MatterMatt ever needs rehab estimates, call that repo's endpoint rather than
forking its catalog.
