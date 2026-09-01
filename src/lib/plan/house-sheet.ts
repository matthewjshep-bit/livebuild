import type { HouseSpec } from "@/lib/plan/describe";
import type { ListingFacts } from "@/lib/listing/types";

/**
 * A house described by pressing things rather than by typing a sentence.
 *
 * The description box was a `<textarea>` read by a regex, in a product whose
 * whole premise is that you should not have to type. Worse, it was the only
 * place the bedroom count could be corrected, and it sat behind a collapsed
 * disclosure triangle - so the number that decides how many bedrooms the house
 * has was two clicks and a sentence away from being wrong.
 *
 * This is the same information as state, and `sheetToSpec` turns it into the
 * same `HouseSpec` the parser produced. That shape is load-bearing in two
 * places that are easy to miss: it becomes the vocabulary the photo classifier
 * is allowed to choose from, and it becomes the room inventory the whole layout
 * is packed from. Producing anything else would quietly change both.
 *
 * The pure half lives here so it can be tested without a browser, and so the
 * one thing that must not drift - what a given set of buttons means - is
 * written down once.
 */

export type SheetRoom = { label: string; level: number };

export type HouseSheet = {
  beds: number;
  /** Halves allowed: 2.5 means two bathrooms and a powder room. */
  baths: number;
  sqft: number | null;
  storeys: number;
  hasBasement: boolean;
  /**
   * Whether the largest bedroom is a primary suite.
   *
   * On by default because almost every house has one, and because it changes
   * more than a name: a primary bedroom implies an ensuite, which shifts what
   * the other bathrooms are called and which floor they land on.
   */
  hasPrimary: boolean;
  /** Rooms chosen beyond the ones a house is assumed to have. */
  extras: SheetRoom[];
  /**
   * Assumed rooms that have been taken away again.
   *
   * The parser added a kitchen, a living room and a hallway to every house
   * without saying so, on the reasoning that a description is a summary rather
   * than an inventory. That reasoning is right and the silence was not: here
   * they arrive already chosen, visibly, and can be removed - which is the same
   * behaviour with the guess admitted.
   */
  removed: string[];
};

export const EMPTY_SHEET: HouseSheet = {
  beds: 3,
  baths: 2,
  sqft: null,
  storeys: 1,
  hasBasement: false,
  hasPrimary: true,
  extras: [],
  removed: [],
};

/** The rooms every house is assumed to have until somebody says otherwise. */
export const ASSUMED = ["Kitchen", "Living Room", "Hallway"];

/**
 * What a house of this shape contains, in the order somebody would walk it.
 *
 * Deliberately the same order and the same names `describeToSpec` produces, so
 * that a house built from the buttons and the same house built from a sentence
 * come out identical. `house-sheet-test` asserts exactly that against the
 * parser rather than against a list written out by hand, so the two cannot
 * drift apart without something failing.
 */
export function sheetToSpec(sheet: HouseSheet): HouseSpec {
  const rooms: SheetRoom[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const add = (label: string, level: number) => {
    const key = `${label}@${level}`;
    if (seen.has(key)) return;
    seen.add(key);
    rooms.push({ label, level });
  };

  const storeys = Math.max(1, Math.round(sheet.storeys));
  const upstairs = storeys > 1;

  // Bedrooms first, because they are what a house is counted in.
  const beds = Math.max(0, Math.round(sheet.beds));
  const primary = sheet.hasPrimary && beds > 0;
  if (beds > 0) {
    for (let i = 0; i < beds; i++) {
      const label = primary && i === 0 ? "Primary Bedroom" : `Bedroom ${i + 1}`;
      add(label, upstairs ? 1 : 0);
    }
    notes.push(`${beds} bedroom${beds === 1 ? "" : "s"}${primary ? ", one of them primary" : ""}`);
  }

  /**
   * Bathrooms, named the way the parser named them.
   *
   * Mirrored deliberately rather than reinvented. A primary bedroom implies an
   * ensuite, which is not merely a nicer name - it changes what the remaining
   * bathrooms are called and, in a two-storey house, which floor they land on.
   * Getting that subtly different from the sentence-reading path would give two
   * houses from the same facts depending on how they were entered.
   */
  const full = Math.floor(Math.max(0, sheet.baths));
  const half = Math.max(0, sheet.baths) - full >= 0.4;
  const ensuite = primary;
  for (let i = 0; i < full; i++) {
    const label =
      ensuite && i === 0
        ? "Primary Ensuite"
        : full - (ensuite ? 1 : 0) > 1
          ? `Bathroom ${i + (ensuite ? 0 : 1)}`
          : "Bathroom";
    add(label, upstairs ? 1 : 0);
  }
  if (half) add("Powder Room", 0);
  if (full > 0 || half) {
    notes.push(
      `${full} full bath${full === 1 ? "" : "s"}${half ? " and a powder room" : ""}` +
        `${ensuite ? ", one an ensuite" : ""}`,
    );
  }

  // Whatever was chosen on top.
  for (const extra of sheet.extras) add(extra.label, extra.level);

  // And the ones a house has whether or not anybody thinks to say so.
  for (const label of ASSUMED) {
    if (!sheet.removed.includes(label)) add(label, 0);
  }

  if (upstairs) {
    if (!sheet.removed.includes("Hallway")) add("Hallway", 1);
    add("Stairs", 0);
    add("Stairs", 1);
    notes.push(`${storeys} storeys, with stairs joining them`);
  }

  if (sheet.hasBasement) {
    add("Basement", -1);
    add("Stairs", -1);
    add("Stairs", 0);
    notes.push("a basement");
  }

  if (sheet.sqft) notes.push(`${sheet.sqft} sqft`);
  if (notes.length === 0) notes.push("a simple one-storey layout");

  return { rooms, notes, source: "parsed" };
}

/**
 * The sheet a listing implies, so the buttons arrive already pressed.
 *
 * The listing path used to build an English sentence out of its facts and push
 * that through the same regex the user's typing went through - which worked,
 * and meant the numbers took a round trip through prose to get back to being
 * numbers. They are numbers here and they stay numbers.
 */
export function sheetFromFacts(
  facts: ListingFacts | null,
  storeysFromSurvey?: number | null,
): HouseSheet {
  const storeys = Math.max(
    1,
    Math.round(storeysFromSurvey ?? facts?.stories ?? 1),
  );
  return {
    ...EMPTY_SHEET,
    beds: facts?.beds ? Math.max(0, Math.round(facts.beds)) : EMPTY_SHEET.beds,
    baths: facts?.baths ?? EMPTY_SHEET.baths,
    sqft: facts?.sqft ?? null,
    storeys,
  };
}

/** Whether a listing said enough for the sheet to be worth pre-filling. */
export function factsWorthUsing(facts: ListingFacts | null): boolean {
  return Boolean(facts && (facts.beds || facts.baths || facts.sqft));
}
