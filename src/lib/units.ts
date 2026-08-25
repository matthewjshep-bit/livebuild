/**
 * Metres are canonical everywhere in the data model; feet exist only for
 * display, because that is what a US listing agent thinks in. Keeping the
 * conversion in one place is what stops the two from leaking into each other.
 */

export const M_PER_FT = 0.3048;

export function mToFt(m: number): number {
  return m / M_PER_FT;
}

export function ftToM(ft: number): number {
  return ft * M_PER_FT;
}

/** e.g. 3.66 -> `12' 0"`. Inches round to the nearest whole inch. */
export function formatFeetInches(meters: number): string {
  const totalInches = Math.round(mToFt(meters) * 12);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return inches === 0 ? `${feet}'` : `${feet}' ${inches}"`;
}

export function formatLength(meters: number, units: "ft" | "m"): string {
  return units === "ft" ? formatFeetInches(meters) : `${meters.toFixed(2)} m`;
}

export function formatArea(squareMeters: number, units: "ft" | "m"): string {
  return units === "ft"
    ? `${Math.round(squareMeters / (M_PER_FT * M_PER_FT))} sq ft`
    : `${squareMeters.toFixed(1)} m2`;
}

export const M2_PER_SQFT = M_PER_FT * M_PER_FT;

export function sqftToM2(sqft: number): number {
  return sqft * M2_PER_SQFT;
}
