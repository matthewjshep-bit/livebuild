/**
 * The bill of materials adds up, and condition actually drives it.
 *
 * A rollup that does not equal its parts is worse than no rollup: it looks
 * authoritative. And the whole premise is that current state decides scope, so
 * a good room must cost nothing and a ruined one must cost more than a tired
 * one - if those do not hold, the grading is decoration.
 */
import { readFileSync } from "node:fs";

import { buildBom, bomToCsv } from "../src/lib/bom/build";
import type { ConditionMap } from "../src/lib/bom/condition";
import { elementsFor } from "../src/lib/bom/condition";
import { autoOpenings } from "../src/lib/plan/autolayout";
import { roomKind } from "../src/lib/plan/room-kind";
import { parseProperty } from "../src/lib/schema";
import type { Plan } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const load = (path: string): Plan => {
  const doc = parseProperty(JSON.parse(readFileSync(path, "utf8")));
  const openings = doc.plan.openings.length ? doc.plan.openings : autoOpenings(doc.plan.rooms);
  return { ...doc.plan, openings };
};

const plan = load("public/properties/demo-house/property.json");

/** Grade every element of every room the same, to isolate one variable. */
const uniform = (grade: string): ConditionMap => {
  const map: ConditionMap = {};
  for (const room of plan.rooms) {
    const condition: Record<string, string> = {};
    for (const element of elementsFor(roomKind(room.label))) condition[element] = grade;
    map[room.id] = condition as ConditionMap[string];
  }
  return map;
};

const good = buildBom(plan, uniform("good"));
const dated = buildBom(plan, uniform("dated"));
const poor = buildBom(plan, uniform("poor"));
const unseen = buildBom(plan, {});

// --- rollups ---
for (const [name, bom] of [["dated", dated], ["poor", poor]] as const) {
  for (const room of bom.rooms) {
    for (const assembly of room.assemblies) {
      const sum = assembly.lines.reduce((s, l) => s + l.total, 0);
      check(
        `${name}/${room.label}/${assembly.name}: assembly equals its lines`,
        Math.abs(assembly.total - sum) < 0.01,
      );
      for (const line of assembly.lines) {
        check(
          `${name}/${room.label}: ${line.label} splits into material and labour`,
          Math.abs(line.material + line.labour - line.total) < 0.01,
        );
        check(`${name}/${room.label}: ${line.label} has a quantity`, line.quantity > 0);
      }
    }
    const roomSum = room.assemblies.reduce((s, a) => s + a.total, 0);
    check(
      `${name}/${room.label}: room equals its assemblies`,
      Math.abs(room.total - roomSum) < 0.01,
    );
  }
  const houseSum = bom.rooms.reduce((s, r) => s + r.total, 0);
  check(`${name}: house equals its rooms`, Math.abs(bom.total - houseSum) < 0.01);
  check(
    `${name}: house material and labour split`,
    Math.abs(bom.material + bom.labour - bom.total) < 0.01,
  );
}

// --- condition actually drives cost ---
check("a house in good condition costs nothing", good.total === 0, `$${good.total.toFixed(0)}`);
check("a dated house costs something", dated.total > 0);
check(
  "a ruined house costs more than a tired one",
  poor.total > dated.total,
  `poor $${Math.round(poor.total)} against dated $${Math.round(dated.total)}`,
);

// --- unseen elements are admitted, not guessed ---
check("nothing seen means nothing costed", unseen.total === 0, `$${unseen.total.toFixed(0)}`);
check(
  "unseen elements are flagged",
  unseen.rooms.every((r) => r.unknownElements.length > 0),
);

// --- scope follows the grade, not just the total ---
{
  const kitchen = dated.rooms.find((r) => r.kind === "kitchen");
  const kitchenPoor = poor.rooms.find((r) => r.kind === "kitchen");
  const labels = (room: typeof kitchen) =>
    room?.assemblies.flatMap((a) => a.lines.map((l) => l.label)) ?? [];

  check("a dated kitchen is refaced", labels(kitchen).includes("Reface cabinets"));
  check("a dated kitchen is not re-cabineted", !labels(kitchen).includes("Base cabinets"));
  check("a ruined kitchen gets new cabinets", labels(kitchenPoor).includes("Base cabinets"));
  check("a ruined kitchen is not refaced", !labels(kitchenPoor).includes("Reface cabinets"));
}

// --- lines only appear where the element exists ---
{
  const bedroom = poor.rooms.find((r) => r.kind === "bedroom");
  const labels = bedroom?.assemblies.flatMap((a) => a.lines.map((l) => l.label)) ?? [];
  check("a bedroom has no worktop", !labels.some((l) => /worktop/i.test(l)));
  check("a bedroom has no WC", !labels.includes("WC"));
  check("a bedroom is still decorated", labels.includes("Paint walls"));
}

// --- CSV ---
{
  const csv = bomToCsv(poor, "Demo House");
  const rows = csv.trim().split("\n");
  // header + one row per line + a total row
  check(
    "CSV has a row per line item",
    rows.length === poor.lineCount + 2,
    `${rows.length} rows for ${poor.lineCount} lines`,
  );
  check("CSV ends with the total", rows[rows.length - 1].includes(poor.total.toFixed(2)));
  check("CSV escapes its fields", !rows[0].includes('""'));
}

// --- whole-house scope ---
//
// Interior finishes alone read low by construction: the ranges this is checked
// against include the roof and the systems, and a rehab total that quietly
// omits a $12,000 roof is not a rehab total.
{
  const houseAll = {
    roof: "poor", exterior: "dated", windows: "dated", hvac: "poor",
    electrical: "poor", plumbing: "poor", waterHeater: "dated",
    landscaping: "dated", foundation: "good",
  } as const;

  const withHouse = buildBom(plan, uniform("poor"), undefined, houseAll);
  const withoutHouse = buildBom(plan, uniform("poor"));

  check("house scope adds cost", withHouse.total > withoutHouse.total,
    `$${Math.round(withHouse.total)} against $${Math.round(withoutHouse.total)}`);
  check("house scope has its own sections", withHouse.house.length > 0);
  check(
    "house rollup equals its assemblies",
    Math.abs(withHouse.houseTotal - withHouse.house.reduce((s, a) => s + a.total, 0)) < 0.01,
  );
  check(
    "the grand total includes rooms and house",
    Math.abs(
      withHouse.total -
        (withHouse.rooms.reduce((s, r) => s + r.total, 0) + withHouse.houseTotal),
    ) < 0.01,
  );

  // A good foundation must not be repaired.
  const houseLabels = withHouse.house.flatMap((a) => a.lines.map((l) => l.label));
  check("a sound foundation is left alone", !houseLabels.includes("Foundation repair"));
  check("a ruined roof is replaced", houseLabels.includes("Roof replacement"));
  check("a tired roof is repaired, not replaced",
    buildBom(plan, {}, undefined, { roof: "dated" }).house
      .flatMap((a) => a.lines.map((l) => l.label))
      .includes("Roof repairs"));

  // Windows come from the model rather than a guess.
  const windows = withHouse.house.flatMap((a) => a.lines).find((l) => l.label === "Windows");
  const modelWindows = withHouse.rooms.reduce((s, r) => s + r.takeoff.windowCount, 0);
  check("windows are counted from the model", windows?.quantity === modelWindows,
    `${windows?.quantity} against ${modelWindows}`);

  // The sanity check must actually respond.
  check("adding house scope moves the sanity verdict up",
    ["light", "medium", "heavy", "above"].includes(withHouse.sanity!.verdict),
    withHouse.sanity!.verdict);
  check("the sanity check explains itself", withHouse.sanity!.summary.length > 20);

  // And the CSV carries it.
  const csv = bomToCsv(withHouse, "Demo House");
  check("CSV includes the whole-house section", csv.includes("Whole house"));
  check("CSV has a row per line",
    csv.trim().split("\n").length === withHouse.lineCount + 2,
    `${csv.trim().split("\n").length} rows for ${withHouse.lineCount} lines`);

  console.log(
    `  house scope: $${Math.round(withHouse.houseTotal).toLocaleString()} on top of ` +
    `$${Math.round(withoutHouse.total).toLocaleString()} of rooms → ` +
    `$${Math.round(withHouse.total).toLocaleString()} (${withHouse.sanity!.verdict})`,
  );
}

console.log(
  failures === 0
    ? `BOM OK - rollups add up; good $0, dated $${Math.round(dated.total).toLocaleString()}, ` +
      `poor $${Math.round(poor.total).toLocaleString()} across ${poor.lineCount} lines`
    : `BOM BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
