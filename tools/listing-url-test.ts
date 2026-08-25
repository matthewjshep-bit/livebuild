/**
 * A pasted link has to name a house.
 *
 * Reading the address out of a Zillow URL is what lets a link work when no
 * scraper is configured, and it is what names the property back to the user the
 * moment they paste it. It is pure string work, so it is worth pinning down
 * here rather than discovering through a three-minute lookup.
 */
import { addressFromZillowUrl, looksLikeUrl } from "../src/lib/listing/url";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const reads: Array<[string, string]> = [
  [
    "https://www.zillow.com/homedetails/902-23rd-Ave-E-Seattle-WA-98112/48749021_zpid/",
    "902 23rd Ave E Seattle WA 98112",
  ],
  // The other shape Zillow uses, with an `_rb` suffix instead of a zpid.
  [
    "https://www.zillow.com/homes/902-23rd-Ave-E-Seattle-WA-98112_rb/",
    "902 23rd Ave E Seattle WA 98112",
  ],
  // No www, and a longer street name.
  [
    "https://zillow.com/homedetails/1600-Pennsylvania-Ave-NW-Washington-DC-20500/84075190_zpid/",
    "1600 Pennsylvania Ave NW Washington DC 20500",
  ],
];

for (const [url, expected] of reads) {
  const got = addressFromZillowUrl(url);
  check(`reads "${expected}"`, got === expected, `got ${JSON.stringify(got)}`);
}

// Nothing must be invented. A link with no address in it has to say so, because
// the alternative is geocoding a guess and confidently building the wrong house.
const blanks = [
  "https://www.zillow.com/",
  "https://www.zillow.com/homedetails/",
  // A different site: its paths do not follow Zillow's shape, so guessing at
  // them would be worse than declining.
  "https://www.redfin.com/WA/Seattle/902-23rd-Ave-E-98112/home/123",
  "not a url at all",
  "",
];
for (const url of blanks) {
  const got = addressFromZillowUrl(url);
  check(`declines ${JSON.stringify(url.slice(0, 40))}`, got === null, `got ${JSON.stringify(got)}`);
}

// The zpid segment is digits-then-underscore and must never be mistaken for the
// address - it has hyphens nowhere but numbers everywhere.
check(
  "the listing id is not read as an address",
  addressFromZillowUrl(
    "https://www.zillow.com/homedetails/902-23rd-Ave-E-Seattle-WA-98112/48749021_zpid/",
  ) !== "48749021 zpid",
);

check("a link is recognised as a link", looksLikeUrl("https://www.zillow.com/x"));
check("an address is not", !looksLikeUrl("902 23rd Ave E, Seattle, WA"));
check("leading space does not fool it", looksLikeUrl("  https://zillow.com/x"));

console.log(
  failures === 0
    ? `LISTING URL OK - ${reads.length} link shapes read, ${blanks.length} declined rather than guessed`
    : `LISTING URL BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
