/** What a listing lookup returns. Shared by the server route and the wizard. */
export type ListingFacts = {
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  yearBuilt: number | null;
  /** Storeys, which decide how the footprint divides into living area. */
  stories: number | null;
};

/**
 * The building outline, when one was found.
 *
 * Optional throughout, and deliberately so: OpenStreetMap's building coverage
 * is excellent in cities that donated county GIS data and absent in newer
 * subdivisions. A miss is the normal case in some places, so nothing downstream
 * may depend on this being present.
 */
export type ListingFootprint = {
  /**
   * The outline as OpenStreetMap holds it, in [lat, lon].
   *
   * Carried alongside the prepared version because how much of the building's
   * detail to keep depends on how many rooms have to fill it - which is not
   * known until the photos have been read. Preparing it again on the client is
   * cheap, and the alternative is a footprint cut into more wings than the
   * house has rooms.
   */
  ring: Array<[number, number]>;
  /** Simplified, squared-up outline in metres, ready to pack rooms into. */
  outline: Array<[number, number]>;
  rects: Array<{ x0: number; y0: number; x1: number; y1: number }>;
  areaSqft: number;
  /** How far the building sits off north, so the model can face the street. */
  rotationDeg: number;
  /**
   * Storeys, worked out from the listing's floor area against the footprint.
   *
   * Zillow's own field is usually missing, so this is derived rather than
   * reported - and it is what stops a two-storey house being built as a
   * bungalow with twice the floor plan.
   */
  storeys: number;
  wayId: number;
  attribution: string;
};

/**
 * Why no building outline came back.
 *
 * Three different situations that used to read as one unhelpful sentence:
 * the address could not be placed on the map at all, it was placed but no
 * building is mapped there, or the map service itself failed. Only the last is
 * worth retrying, and the user can do something about the first.
 */
export type FootprintMiss = "not-located" | "no-building" | "lookup-failed";

export type ListingResult = {
  address: string;
  photos: string[];
  photoCount: number;
  facts: ListingFacts;
  remarks: string | null;
  status: string | null;
  listPrice: number | null;
  /** Parcel coordinates from the listing, which beat geocoding the address. */
  location: { lat: number; lon: number } | null;
  footprint: ListingFootprint | null;
  /** Set when `footprint` is null, saying which of the three happened. */
  footprintMiss?: FootprintMiss | null;
  /** Whether listing scraping is configured, so the UI can say what is missing. */
  scraperConfigured?: boolean;
};

/**
 * Turn listing facts into the sentence the describe step already understands.
 *
 * Rather than a second path into the plan, the facts are written as the same
 * plain English a person would type - so one parser, one AI prompt and one set
 * of tests cover both, and what the wizard understood stays visible and
 * editable instead of arriving as hidden state.
 */
export function factsToDescription(facts: ListingFacts, remarks?: string | null): string {
  const parts: string[] = [];

  if (facts.beds) parts.push(`${facts.beds} bed`);
  if (facts.baths) parts.push(`${facts.baths} bath`);

  let sentence = parts.length > 0 ? parts.join(" ") : "house";
  if (facts.sqft) sentence += `, ${facts.sqft} sqft`;
  // Written as words rather than passed as a number, so the storey count goes
  // through the same parser as everything else - which already knows to put the
  // bedrooms upstairs and stairs on both floors.
  if (facts.stories && facts.stories >= 2) sentence += `, ${facts.stories} storeys`;
  if (facts.yearBuilt) sentence += `, built ${facts.yearBuilt}`;

  // The agent's own remarks are where rooms actually get named - "formal dining
  // room", "bonus room over the garage" - which the bed/bath counts never say.
  const trimmed = (remarks ?? "").trim();
  return trimmed ? `${sentence}. ${trimmed.slice(0, 900)}` : sentence;
}
