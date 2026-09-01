/**
 * Photos get labelled without being asked about.
 *
 * Labelling used to be a step the user did, one tap per photo. It now happens
 * during the build, so what matters is that it happens at all and that the
 * labels come from this house's own vocabulary.
 *
 * Accuracy is NOT asserted. The demo house is synthetic - flat untextured boxes
 * - and the model scores 2-3 of 6 on it at every resolution while correctly
 * marking almost everything low confidence. Real listing photos carry far more
 * signal; this fixture cannot predict how it does on them.
 */
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { addPhotos, build, freshStart, savedProperty } from "./lib/flow.mjs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const dir = "public/properties/demo-house/photos";
const files = readdirSync(dir).map((f) => join(dir, f));

const VOCAB =
  /living|kitchen|hall|bed|bath|dining|entry|office|laundry|stairs|garage|outside|powder|closet|family/i;

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await freshStart(page, base);
await addPhotos(page, files);
// The vocabulary the classifier is offered comes from the house sheet now
// rather than from a sentence, and the sheet is a screen of its own - so it is
// filled in on the way past rather than before setting off.
const arrived = await build(page, { house: { beds: 3, baths: 2 } });

// Read the finished property, not the draft: a successful build clears the
// draft, so looking there reports zero labels for a run that worked perfectly.
// That made this suite pass or fail depending on what the previous one left
// behind, which is worse than failing outright.
const property = await savedProperty(page);
const roomById = new Map((property?.plan.rooms ?? []).map((r) => [r.id, r.label]));
const placed = (property?.nodes ?? []).map((n) => roomById.get(n.roomId)).filter(Boolean);
const inVocabulary = placed.every((room) => VOCAB.test(room));
const roomsUsed = [...new Set(placed)];

const ok = arrived && placed.length === files.length && inVocabulary;

console.log(
  JSON.stringify(
    {
      photosPlaced: `${placed.length}/${files.length}`,
      roomsUsed,
      labelsFromHouseVocabulary: inVocabulary,
      errors: errors.slice(0, 3),
      verdict: ok
        ? `AUTO-TAG OK - all ${files.length} photos labelled during the build and placed into ${roomsUsed.length} rooms`
        : `FAILED - arrived=${arrived} placed=${placed.length}/${files.length} vocabulary=${inVocabulary}`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(ok ? 0 : 1);
