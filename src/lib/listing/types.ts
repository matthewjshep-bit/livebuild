/** What a listing lookup returns. Shared by the server route and the wizard. */
export type ListingFacts = {
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  yearBuilt: number | null;
};

export type ListingResult = {
  address: string;
  photos: string[];
  photoCount: number;
  facts: ListingFacts;
  remarks: string | null;
  status: string | null;
  listPrice: number | null;
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
  if (facts.yearBuilt) sentence += `, built ${facts.yearBuilt}`;

  // The agent's own remarks are where rooms actually get named - "formal dining
  // room", "bonus room over the garage" - which the bed/bath counts never say.
  const trimmed = (remarks ?? "").trim();
  return trimmed ? `${sentence}. ${trimmed.slice(0, 900)}` : sentence;
}
