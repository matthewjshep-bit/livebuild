import type { Element, Grade, HouseElement } from "@/lib/bom/condition";
import type { RoomTakeoff } from "@/lib/bom/takeoff";
import type { RoomKind } from "@/lib/plan/room-kind";

/**
 * The rate card and the line items it prices.
 *
 * Units match the takeoff - dollars per square foot, per linear foot, per unit
 * - so the quantities derived from the model drive the money directly. That is
 * the whole point of the exercise, and it is what the ported whole-house
 * catalog cannot do: its costs are flat per house, with nothing to multiply.
 *
 * **The rates are the user's to own.** These defaults are a reasonable US
 * mid-grade starting point and nothing more. They are editable per property,
 * and the whole-house estimate shown beside the total exists partly so a badly
 * wrong rate card is visible rather than silent.
 *
 * Every rate carries a labour share, so each line splits into material and
 * labour. That split is most of what makes the output usable for a bid rather
 * than a number to look at.
 */

export type Unit = "sqft" | "lf" | "ea" | "flat";

export type Rate = {
  id: string;
  label: string;
  unit: Unit;
  rate: number;
  /** Fraction of the line that is labour, 0..1. */
  labourShare: number;
};

export const DEFAULT_RATES: Rate[] = [
  // Finishes
  { id: "paint-wall", label: "Paint walls", unit: "sqft", rate: 2.4, labourShare: 0.75 },
  { id: "paint-ceiling", label: "Paint ceiling", unit: "sqft", rate: 2.1, labourShare: 0.78 },
  { id: "drywall-patch", label: "Drywall repair", unit: "sqft", rate: 4.5, labourShare: 0.65 },
  { id: "popcorn", label: "Remove popcorn ceiling", unit: "sqft", rate: 2.6, labourShare: 0.85 },

  // Flooring
  { id: "floor-lvp", label: "LVP flooring", unit: "sqft", rate: 6.5, labourShare: 0.45 },
  { id: "floor-tile", label: "Tile flooring", unit: "sqft", rate: 14, labourShare: 0.55 },
  { id: "floor-carpet", label: "Carpet", unit: "sqft", rate: 4.2, labourShare: 0.4 },
  { id: "floor-refinish", label: "Refinish timber floor", unit: "sqft", rate: 4.5, labourShare: 0.8 },

  // Trim and joinery
  { id: "baseboard", label: "Baseboard", unit: "lf", rate: 7.5, labourShare: 0.55 },
  { id: "door-interior", label: "Interior door, hung", unit: "ea", rate: 470, labourShare: 0.45 },
  { id: "cab-base", label: "Base cabinets", unit: "lf", rate: 320, labourShare: 0.35 },
  { id: "cab-wall", label: "Wall cabinets", unit: "lf", rate: 260, labourShare: 0.35 },
  { id: "cab-reface", label: "Reface cabinets", unit: "lf", rate: 145, labourShare: 0.6 },
  { id: "counter-quartz", label: "Quartz worktop", unit: "sqft", rate: 78, labourShare: 0.3 },
  { id: "backsplash", label: "Tile backsplash", unit: "sqft", rate: 22, labourShare: 0.6 },

  // Fixtures
  { id: "light-fixture", label: "Light fitting", unit: "ea", rate: 180, labourShare: 0.5 },
  { id: "appliance-pkg", label: "Appliance package", unit: "flat", rate: 4600, labourShare: 0.1 },
  { id: "vanity", label: "Vanity and basin", unit: "ea", rate: 950, labourShare: 0.4 },
  { id: "toilet", label: "WC", unit: "ea", rate: 520, labourShare: 0.45 },
  { id: "tub-shower", label: "Bath or shower", unit: "ea", rate: 2400, labourShare: 0.5 },
  { id: "wall-tile", label: "Wall tiling", unit: "sqft", rate: 24, labourShare: 0.62 },
  { id: "window-unit", label: "Window, fitted", unit: "ea", rate: 780, labourShare: 0.4 },
];

/**
 * A line item: what it is, what it costs, and when it applies.
 *
 * `dependsOn` and `triggersAt` are what tie condition to scope. A line appears
 * only when the element it depends on is in a state that calls for it, which is
 * how "dated" produces a reface and "poor" produces new cabinets without any
 * branching logic in the builder.
 */
export type LineSpec = {
  id: string;
  assembly: string;
  label: string;
  rateId: string;
  /** A takeoff field, or a fixed count. */
  quantityFrom: keyof RoomTakeoff | { fixed: number };
  dependsOn: Element;
  triggersAt: Grade[];
  /** Restrict to certain room kinds; absent means every room that has the element. */
  kinds?: RoomKind[];
  note?: string;
};

const REFRESH: Grade[] = ["dated"];
const REPLACE: Grade[] = ["poor"];
const EITHER: Grade[] = ["dated", "poor"];

export const LINE_SPECS: LineSpec[] = [
  // --- Finishes, in every room ---
  {
    id: "paint-walls",
    assembly: "Decoration",
    label: "Paint walls",
    rateId: "paint-wall",
    quantityFrom: "wallSqft",
    dependsOn: "walls",
    triggersAt: EITHER,
  },
  {
    id: "wall-repair",
    assembly: "Decoration",
    label: "Repair walls before painting",
    rateId: "drywall-patch",
    quantityFrom: "wallSqft",
    dependsOn: "walls",
    triggersAt: REPLACE,
    note: "Only where walls are damaged rather than merely tired.",
  },
  {
    id: "paint-ceiling",
    assembly: "Decoration",
    label: "Paint ceiling",
    rateId: "paint-ceiling",
    quantityFrom: "ceilingSqft",
    dependsOn: "ceiling",
    triggersAt: EITHER,
  },
  {
    id: "popcorn",
    assembly: "Decoration",
    label: "Remove textured ceiling",
    rateId: "popcorn",
    quantityFrom: "ceilingSqft",
    dependsOn: "ceiling",
    triggersAt: REPLACE,
  },

  // --- Flooring, by what the room is ---
  {
    id: "floor-soft",
    assembly: "Flooring",
    label: "Carpet",
    rateId: "floor-carpet",
    quantityFrom: "floorSqft",
    dependsOn: "floor",
    triggersAt: EITHER,
    kinds: ["bedroom", "primary-bedroom", "closet"],
  },
  {
    id: "floor-wet",
    assembly: "Flooring",
    label: "Tile flooring",
    rateId: "floor-tile",
    quantityFrom: "floorSqft",
    dependsOn: "floor",
    triggersAt: EITHER,
    kinds: ["bathroom", "powder", "laundry"],
  },
  {
    id: "floor-hard",
    assembly: "Flooring",
    label: "LVP flooring",
    rateId: "floor-lvp",
    quantityFrom: "floorSqft",
    dependsOn: "floor",
    triggersAt: EITHER,
    kinds: ["living", "kitchen", "dining", "hallway", "entry", "office", "stairs", "basement", "other"],
  },

  // --- Trim ---
  {
    id: "baseboard",
    assembly: "Trim & doors",
    label: "Baseboard",
    rateId: "baseboard",
    quantityFrom: "baseboardLf",
    dependsOn: "trim",
    triggersAt: EITHER,
  },
  {
    id: "doors",
    assembly: "Trim & doors",
    label: "Interior doors",
    rateId: "door-interior",
    quantityFrom: "doorCount",
    dependsOn: "trim",
    triggersAt: REPLACE,
  },

  // --- Lighting ---
  {
    id: "lighting",
    assembly: "Electrical",
    label: "Light fittings",
    rateId: "light-fixture",
    quantityFrom: { fixed: 2 },
    dependsOn: "lighting",
    triggersAt: EITHER,
  },

  // --- Kitchen ---
  {
    id: "cab-reface",
    assembly: "Cabinetry",
    label: "Reface cabinets",
    rateId: "cab-reface",
    quantityFrom: "cabinetRunLf",
    dependsOn: "cabinets",
    triggersAt: REFRESH,
    kinds: ["kitchen", "laundry"],
  },
  {
    id: "cab-base",
    assembly: "Cabinetry",
    label: "Base cabinets",
    rateId: "cab-base",
    quantityFrom: "cabinetRunLf",
    dependsOn: "cabinets",
    triggersAt: REPLACE,
    kinds: ["kitchen", "laundry"],
  },
  {
    id: "cab-wall",
    assembly: "Cabinetry",
    label: "Wall cabinets",
    rateId: "cab-wall",
    quantityFrom: "cabinetRunLf",
    dependsOn: "cabinets",
    triggersAt: REPLACE,
    kinds: ["kitchen"],
  },
  {
    id: "counters",
    assembly: "Worktops",
    label: "Quartz worktop",
    rateId: "counter-quartz",
    quantityFrom: "cabinetRunLf",
    dependsOn: "counters",
    triggersAt: EITHER,
    kinds: ["kitchen"],
    note: "Priced on the cabinet run at roughly 2ft deep.",
  },
  {
    id: "backsplash",
    assembly: "Worktops",
    label: "Backsplash",
    rateId: "backsplash",
    quantityFrom: "cabinetRunLf",
    dependsOn: "backsplash",
    triggersAt: EITHER,
    kinds: ["kitchen"],
  },
  {
    id: "appliances",
    assembly: "Appliances",
    label: "Appliance package",
    rateId: "appliance-pkg",
    quantityFrom: { fixed: 1 },
    dependsOn: "appliances",
    triggersAt: EITHER,
    kinds: ["kitchen"],
  },

  // --- Bathrooms ---
  {
    id: "vanity",
    assembly: "Sanitaryware",
    label: "Vanity and basin",
    rateId: "vanity",
    quantityFrom: { fixed: 1 },
    dependsOn: "vanity",
    triggersAt: EITHER,
    kinds: ["bathroom", "powder"],
  },
  {
    id: "toilet",
    assembly: "Sanitaryware",
    label: "WC",
    rateId: "toilet",
    quantityFrom: { fixed: 1 },
    dependsOn: "toilet",
    triggersAt: EITHER,
    kinds: ["bathroom", "powder"],
  },
  {
    id: "bathing",
    assembly: "Sanitaryware",
    label: "Bath or shower",
    rateId: "tub-shower",
    quantityFrom: { fixed: 1 },
    dependsOn: "bathing",
    triggersAt: EITHER,
    kinds: ["bathroom"],
  },
  {
    id: "wall-tile",
    assembly: "Tiling",
    label: "Wall tiling",
    rateId: "wall-tile",
    quantityFrom: "cabinetRunLf",
    dependsOn: "tile",
    triggersAt: EITHER,
    kinds: ["bathroom"],
    note: "Priced on the wet wall run to ceiling height.",
  },
];

/**
 * Whole-house items, priced flat rather than by takeoff.
 *
 * These genuinely have no per-room quantity - a house has one roof - so they
 * keep the wholesaling catalog's flat costs and its size factor. `scales` marks
 * the ones whose cost really tracks house size: a kitchen has fewer linear feet
 * in a small house, but a water heater is one water heater at any size.
 */
export type HouseLineSpec = {
  id: string;
  assembly: string;
  label: string;
  cost: number;
  labourShare: number;
  scales: boolean;
  dependsOn: HouseElement;
  triggersAt: Grade[];
  note?: string;
};

export const HOUSE_LINE_SPECS: HouseLineSpec[] = [
  { id: "roof", assembly: "Roof & structure", label: "Roof replacement", cost: 12000, labourShare: 0.55, scales: true, dependsOn: "roof", triggersAt: REPLACE },
  { id: "roof-repair", assembly: "Roof & structure", label: "Roof repairs", cost: 2500, labourShare: 0.7, scales: true, dependsOn: "roof", triggersAt: REFRESH },
  { id: "foundation", assembly: "Roof & structure", label: "Foundation repair", cost: 10000, labourShare: 0.7, scales: true, dependsOn: "foundation", triggersAt: REPLACE },

  { id: "paint-ext", assembly: "Exterior", label: "Exterior paint", cost: 6000, labourShare: 0.75, scales: true, dependsOn: "exterior", triggersAt: EITHER },
  { id: "siding", assembly: "Exterior", label: "Siding repair", cost: 4000, labourShare: 0.6, scales: true, dependsOn: "exterior", triggersAt: REPLACE },
  { id: "landscape", assembly: "Exterior", label: "Yard cleanup & landscaping", cost: 2500, labourShare: 0.8, scales: false, dependsOn: "landscaping", triggersAt: EITHER },

  { id: "hvac", assembly: "Systems", label: "HVAC / furnace", cost: 8000, labourShare: 0.4, scales: true, dependsOn: "hvac", triggersAt: REPLACE },
  { id: "hvac-service", assembly: "Systems", label: "HVAC service", cost: 800, labourShare: 0.85, scales: false, dependsOn: "hvac", triggersAt: REFRESH },
  { id: "elec", assembly: "Systems", label: "Electrical panel & updates", cost: 4000, labourShare: 0.65, scales: false, dependsOn: "electrical", triggersAt: REPLACE },
  { id: "plumb", assembly: "Systems", label: "Plumbing updates", cost: 5000, labourShare: 0.65, scales: true, dependsOn: "plumbing", triggersAt: REPLACE },
  { id: "wh", assembly: "Systems", label: "Water heater", cost: 1800, labourShare: 0.35, scales: false, dependsOn: "waterHeater", triggersAt: EITHER },
];

/** Windows are the one house-level item with a real count, from the model. */
export const WINDOW_RATE_ID = "window-unit";

export function rateById(rates: Rate[], id: string): Rate | undefined {
  return rates.find((r) => r.id === id);
}

/** Merge per-property overrides over the defaults. */
export function resolveRates(overrides?: Record<string, number>): Rate[] {
  if (!overrides) return DEFAULT_RATES;
  return DEFAULT_RATES.map((rate) =>
    overrides[rate.id] !== undefined ? { ...rate, rate: overrides[rate.id] } : rate,
  );
}
