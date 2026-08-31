/**
 * Reading a Drive link.
 *
 * Links arrive in more shapes than you would guess - opened from the sidebar,
 * off a share sheet, from an old email - and they are all the same id in the
 * end. Getting this wrong is silent: a link that does not parse looks exactly
 * like a folder that is empty, and the user has no way to tell which.
 *
 * The half that talks to Google is not exercised here. It needs a key and a
 * real folder, and `drive-flow-test.mjs` covers it where it can skip honestly.
 */
import { parseDriveUrl } from "../src/lib/drive/url";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const FOLDER = "1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuV";
const FILE = "1zZyYxXwWvVuUtTsSrRqQpPoOnNmMlLkK";

// --- The shapes a folder link actually comes in ---
const folders: Array<[string, string]> = [
  ["a plain share link", `https://drive.google.com/drive/folders/${FOLDER}`],
  ["with a sharing suffix", `https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`],
  ["with a drive suffix", `https://drive.google.com/drive/folders/${FOLDER}?usp=drive_link`],
  ["opened from the sidebar", `https://drive.google.com/drive/u/0/folders/${FOLDER}`],
  ["from a second account", `https://drive.google.com/drive/u/2/folders/${FOLDER}`],
  ["with surrounding whitespace", `  https://drive.google.com/drive/folders/${FOLDER}  `],
  ["without a scheme", `drive.google.com/drive/folders/${FOLDER}`],
];

for (const [name, url] of folders) {
  const parsed = parseDriveUrl(url);
  check(`${name} is read as a folder`, parsed?.kind === "folder", JSON.stringify(parsed));
  check(`${name} keeps the right id`, parsed?.id === FOLDER, parsed?.id);
}

// --- Single files, so one photograph does not need a different path ---
const files: Array<[string, string]> = [
  ["a file link", `https://drive.google.com/file/d/${FILE}/view`],
  ["a file link with a suffix", `https://drive.google.com/file/d/${FILE}/view?usp=sharing`],
  ["an old open link", `https://drive.google.com/open?id=${FILE}`],
];

for (const [name, url] of files) {
  const parsed = parseDriveUrl(url);
  check(`${name} is read as a file`, parsed?.kind === "file", JSON.stringify(parsed));
  check(`${name} keeps the right id`, parsed?.id === FILE, parsed?.id);
}

// A bare id is what somebody pastes when they have already dug it out.
check("a bare id is taken as a folder", parseDriveUrl(FOLDER)?.id === FOLDER);

// --- Things that are not Drive links must be refused, not guessed at ---
const refused = [
  "",
  "   ",
  "not a link at all",
  "123 Main St, Seattle, WA 98101",
  "https://www.zillow.com/homedetails/20491-Forest-Hills-Dr/12345_zpid/",
  "https://drive.google.com/",
  "https://drive.google.com/drive/folders/",
  "https://example.com/drive/folders/" + FOLDER,
  "https://drive.google.com/drive/folders/short",
];
for (const input of refused) {
  check(`refuses ${JSON.stringify(input.slice(0, 40))}`, parseDriveUrl(input) === null,
    JSON.stringify(parseDriveUrl(input)));
}

// --- An id can never be a path ---
//
// The id is interpolated into a Drive API URL, so anything that could carry a
// slash or a query is a way out of that URL.
for (const nasty of [
  "https://drive.google.com/drive/folders/../../etc/passwd",
  `https://drive.google.com/drive/folders/${FOLDER}/../other`,
]) {
  const parsed = parseDriveUrl(nasty);
  check(
    `no path escapes from ${nasty.slice(-24)}`,
    parsed === null || (!parsed.id.includes("/") && !parsed.id.includes("..")),
    JSON.stringify(parsed),
  );
}

console.log(
  failures === 0
    ? `DRIVE OK - ${folders.length} folder link shapes and ${files.length} file shapes read, ${refused.length} declined rather than guessed`
    : `DRIVE BROKEN - ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
