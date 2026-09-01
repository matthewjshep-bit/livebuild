import {
  HOUSE_LINE_SPECS,
  type LineSpec,
  LINE_SPECS,
  type Rate,
  WINDOW_RATE_ID,
  rateById,
  resolveRates,
} from "@/lib/bom/catalog";
import {
  type ConditionMap,
  type Grade,
  type HouseCondition,
  HOUSE_ELEMENTS,
  type RoomCondition,
  effectiveGrade,
  elementsFor,
  isUnknown,
} from "@/lib/bom/condition";
import { type RoomTakeoff, livingAreaSqft, takeoffForPlan } from "@/lib/bom/takeoff";
import { compareToBands, type Comparison, sizeFactor } from "@/lib/bom/whole-house";
import type { Plan } from "@/lib/schema";

/**
 * Assemble the indented bill of materials.
 *
 * Four levels, as a PLM tool would present them: house, room, assembly, line.
 * Each level's total is the sum of its children and nothing else, which is what
 * makes the tree trustworthy - a number that does not equal its parts is worse
 * than no number, because it looks authoritative.
 *
 * Selection is entirely declarative. Each line says which element it depends on
 * and at which grades it applies, so a dated kitchen produces a reface and a
 * poor one produces new cabinets without a single branch here.
 */

export type BomLine = {
  id: string;
  label: string;
  assembly: string;
  quantity: number;
  unit: string;
  rate: number;
  material: number;
  labour: number;
  total: number;
  /** Why this line is here. */
  because: { element: string; grade: Grade };
  /** True when the grade was assumed rather than observed. */
  assumed: boolean;
  note?: string;
};

export type BomAssembly = {
  name: string;
  lines: BomLine[];
  material: number;
  labour: number;
  total: number;
};

export type BomRoom = {
  roomId: string;
  label: string;
  kind: string;
  level: number;
  takeoff: RoomTakeoff;
  assemblies: BomAssembly[];
  material: number;
  labour: number;
  total: number;
  /** Elements with no observed grade, so the gap is visible in the tree. */
  unknownElements: string[];
};

export type Bom = {
  rooms: BomRoom[];
  /** Roof, systems and exterior - real costs that belong to no room. */
  house: BomAssembly[];
  houseMaterial: number;
  houseLabour: number;
  houseTotal: number;
  livingSqft: number;
  /** The itemised total placed against whole-project ranges by house size. */
  /** Null for a single room, which has no house-sized range to be compared to. */
  sanity: Comparison | null;
  unknownHouseElements: string[];
  material: number;
  labour: number;
  total: number;
  lineCount: number;
  /** How much of the total rests on assumed rather than observed condition. */
  assumedTotal: number;
  rates: Rate[];
};

function quantityFor(spec: LineSpec, takeoff: RoomTakeoff): number {
  if (typeof spec.quantityFrom === "object") return spec.quantityFrom.fixed;
  const value = takeoff[spec.quantityFrom];
  return typeof value === "number" ? value : 0;
}

function buildRoom(
  takeoff: RoomTakeoff,
  condition: RoomCondition,
  rates: Rate[],
): BomRoom {
  const applicable = new Set(elementsFor(takeoff.kind));
  const byAssembly = new Map<string, BomLine[]>();

  for (const spec of LINE_SPECS) {
    if (spec.kinds && !spec.kinds.includes(takeoff.kind)) continue;
    // A line cannot apply to an element the room does not have - no worktops in
    // a bedroom, however the condition map happens to be populated.
    if (!applicable.has(spec.dependsOn)) continue;

    const observed = condition[spec.dependsOn];
    const grade = effectiveGrade(observed);
    if (!spec.triggersAt.includes(grade)) continue;

    const rate = rateById(rates, spec.rateId);
    if (!rate) continue;

    const quantity = quantityFor(spec, takeoff);
    if (quantity <= 0) continue;

    const total = quantity * rate.rate;
    const line: BomLine = {
      id: `${takeoff.roomId}:${spec.id}`,
      label: spec.label,
      assembly: spec.assembly,
      quantity,
      unit: rate.unit,
      rate: rate.rate,
      labour: total * rate.labourShare,
      material: total * (1 - rate.labourShare),
      total,
      because: { element: spec.dependsOn, grade },
      assumed: isUnknown(observed),
      note: spec.note,
    };

    const list = byAssembly.get(spec.assembly) ?? [];
    list.push(line);
    byAssembly.set(spec.assembly, list);
  }

  const assemblies: BomAssembly[] = [...byAssembly.entries()].map(([name, lines]) => ({
    name,
    lines,
    material: lines.reduce((s, l) => s + l.material, 0),
    labour: lines.reduce((s, l) => s + l.labour, 0),
    total: lines.reduce((s, l) => s + l.total, 0),
  }));

  return {
    roomId: takeoff.roomId,
    label: takeoff.label,
    kind: takeoff.kind,
    level: takeoff.level,
    takeoff,
    assemblies,
    material: assemblies.reduce((s, a) => s + a.material, 0),
    labour: assemblies.reduce((s, a) => s + a.labour, 0),
    total: assemblies.reduce((s, a) => s + a.total, 0),
    unknownElements: [...applicable].filter((e) => isUnknown(condition[e])),
  };
}

/**
 * Whole-house scope: roof, systems, exterior.
 *
 * Priced flat with the size factor rather than from a takeoff, because a house
 * has one roof and one panel however many rooms it has. Windows are the
 * exception - the model knows how many there are, so they are counted.
 */
function buildHouseScope(
  plan: Plan,
  condition: HouseCondition,
  rates: Rate[],
  livingSqft: number,
  windowCount: number,
): BomAssembly[] {
  const factor = sizeFactor(livingSqft);
  const byAssembly = new Map<string, BomLine[]>();

  const push = (line: BomLine) => {
    const list = byAssembly.get(line.assembly) ?? [];
    list.push(line);
    byAssembly.set(line.assembly, list);
  };

  for (const spec of HOUSE_LINE_SPECS) {
    const observed = condition[spec.dependsOn];
    const grade = effectiveGrade(observed);
    if (!spec.triggersAt.includes(grade)) continue;

    const total = spec.scales ? spec.cost * factor : spec.cost;
    push({
      id: `house:${spec.id}`,
      label: spec.label,
      assembly: spec.assembly,
      quantity: 1,
      unit: "flat",
      rate: total,
      labour: total * spec.labourShare,
      material: total * (1 - spec.labourShare),
      total,
      because: { element: spec.dependsOn, grade },
      assumed: isUnknown(observed),
      note: spec.note,
    });
  }

  // Windows are counted from the model rather than guessed.
  const windowGrade = effectiveGrade(condition.windows);
  const windowRate = rateById(rates, WINDOW_RATE_ID);
  if (windowRate && windowCount > 0 && (windowGrade === "dated" || windowGrade === "poor")) {
    const total = windowCount * windowRate.rate;
    push({
      id: "house:windows",
      label: "Windows",
      assembly: "Exterior",
      quantity: windowCount,
      unit: "ea",
      rate: windowRate.rate,
      labour: total * windowRate.labourShare,
      material: total * (1 - windowRate.labourShare),
      total,
      because: { element: "windows", grade: windowGrade },
      assumed: isUnknown(condition.windows),
      note: "Counted from the model.",
    });
  }

  return [...byAssembly.entries()].map(([name, lines]) => ({
    name,
    lines,
    material: lines.reduce((s, l) => s + l.material, 0),
    labour: lines.reduce((s, l) => s + l.labour, 0),
    total: lines.reduce((s, l) => s + l.total, 0),
  }));
}

export function buildBom(
  plan: Plan,
  condition: ConditionMap = {},
  rateOverrides?: Record<string, number>,
  houseCondition: HouseCondition = {},
  /** "room" suppresses the judgements that are only sensible about a house. */
  kind: "room" | "house" = "house",
): Bom {
  const rates = resolveRates(rateOverrides);
  const rooms = takeoffForPlan(plan)
    .map((takeoff) => buildRoom(takeoff, condition[takeoff.roomId] ?? {}, rates))
    // A room with nothing to do still belongs in the tree - "this room needs
    // nothing" is a finding, not an omission.
    .sort((a, b) => a.level - b.level || b.total - a.total);

  const livingSqft = livingAreaSqft(plan);
  const windowCount = rooms.reduce((s, r) => s + r.takeoff.windowCount, 0);
  const house = buildHouseScope(plan, houseCondition, rates, livingSqft, windowCount);

  const roomLines = rooms.flatMap((r) => r.assemblies.flatMap((a) => a.lines));
  const houseLines = house.flatMap((a) => a.lines);
  const lines = [...roomLines, ...houseLines];

  const material = rooms.reduce((s, r) => s + r.material, 0) + house.reduce((s, a) => s + a.material, 0);
  const labour = rooms.reduce((s, r) => s + r.labour, 0) + house.reduce((s, a) => s + a.labour, 0);
  const total = material + labour;

  return {
    rooms,
    house,
    houseMaterial: house.reduce((s, a) => s + a.material, 0),
    houseLabour: house.reduce((s, a) => s + a.labour, 0),
    houseTotal: house.reduce((s, a) => s + a.total, 0),
    livingSqft,
    /**
     * Both of these are statements about a house, so a room gets neither.
     *
     * The bands compare a total against what a rehab of that size usually
     * costs, and the smallest band starts at a thousand square feet - so a
     * kitchen was reliably told it came in "below the usual range for a house
     * under 1,000 sqft", which is true, useless and slightly alarming. The
     * unknown-elements list is worse: it reported a roof, a furnace and a
     * foundation as ungraded for a room that has none of them.
     */
    sanity: kind === "room" ? null : compareToBands(total, livingSqft),
    unknownHouseElements:
      kind === "room" ? [] : HOUSE_ELEMENTS.filter((e) => isUnknown(houseCondition[e])),
    material,
    labour,
    total,
    lineCount: lines.length,
    assumedTotal: lines.filter((l) => l.assumed).reduce((s, l) => s + l.total, 0),
    rates,
  };
}

/**
 * Flatten to CSV: one row per line, with its full path.
 *
 * Repeating house/room/assembly on every row rather than indenting, because the
 * first thing anyone does with this is drop it into a spreadsheet and pivot on
 * it - and a tree drawn with leading spaces cannot be sorted.
 */
export function bomToCsv(bom: Bom, propertyLabel: string): string {
  const escape = (value: string | number) => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const rows = [
    [
      "Property", "Level", "Room", "Assembly", "Item",
      "Quantity", "Unit", "Rate", "Material", "Labour", "Total",
      "Because", "Grade", "Assumed",
    ],
  ];

  for (const assembly of bom.house) {
    for (const line of assembly.lines) {
      rows.push([
        propertyLabel, "", "Whole house", assembly.name, line.label,
        line.quantity.toFixed(1), line.unit, line.rate.toFixed(2),
        line.material.toFixed(2), line.labour.toFixed(2), line.total.toFixed(2),
        line.because.element, line.because.grade, line.assumed ? "yes" : "no",
      ]);
    }
  }

  for (const room of bom.rooms) {
    for (const assembly of room.assemblies) {
      for (const line of assembly.lines) {
        rows.push([
          propertyLabel,
          String(room.level),
          room.label,
          assembly.name,
          line.label,
          line.quantity.toFixed(1),
          line.unit,
          line.rate.toFixed(2),
          line.material.toFixed(2),
          line.labour.toFixed(2),
          line.total.toFixed(2),
          line.because.element,
          line.because.grade,
          line.assumed ? "yes" : "no",
        ]);
      }
    }
  }

  rows.push([
    propertyLabel, "", "TOTAL", "", "", "", "", "",
    bom.material.toFixed(2), bom.labour.toFixed(2), bom.total.toFixed(2), "", "", "",
  ]);

  return rows.map((row) => row.map(escape).join(",")).join("\n");
}
