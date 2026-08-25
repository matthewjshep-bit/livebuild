import type { RoomKind } from "@/lib/plan/room-kind";

/**
 * What state a room is in, element by element.
 *
 * The grade vocabulary is taken from the wholesaling repo's photo scan, and the
 * distinction it draws is worth preserving because it is not obvious: **dated**
 * means the thing works and looks wrong, **poor** means it is failing. They
 * lead to different work and very different money - a dated kitchen gets its
 * doors refaced, a poor one gets torn out.
 *
 * `not_visible` exists so an unseen element can be admitted rather than
 * guessed. Quietly costing an unphotographed room as if it were ruined is the
 * worst available outcome: it is wrong, expensive, and invisible.
 *
 * Unlike walls and furniture, this is **stored**. It is an observation the user
 * corrects, not something derivable from the plan.
 */

export const GRADES = ["good", "fair", "dated", "poor", "not_visible"] as const;
export type Grade = (typeof GRADES)[number];

export const ELEMENTS = [
  "floor",
  "walls",
  "ceiling",
  "trim",
  "lighting",
  "cabinets",
  "counters",
  "appliances",
  "backsplash",
  "vanity",
  "bathing",
  "toilet",
  "tile",
] as const;
export type Element = (typeof ELEMENTS)[number];

/** Every room has these. */
const UNIVERSAL: Element[] = ["floor", "walls", "ceiling", "trim", "lighting"];

/**
 * Which elements a room of each kind actually has.
 *
 * Asking the model to grade a bedroom's countertops wastes a question and
 * invites an invented answer; asking a garage about its trim is the same
 * mistake in reverse.
 */
const BY_KIND: Partial<Record<RoomKind, Element[]>> = {
  kitchen: [...UNIVERSAL, "cabinets", "counters", "appliances", "backsplash"],
  bathroom: [...UNIVERSAL, "vanity", "bathing", "toilet", "tile"],
  powder: [...UNIVERSAL, "vanity", "toilet"],
  laundry: [...UNIVERSAL, "cabinets"],
  garage: ["floor", "walls", "lighting"],
  outside: [],
  stairs: ["floor", "walls", "trim", "lighting"],
  closet: ["floor", "walls", "trim"],
};

export function elementsFor(kind: RoomKind): Element[] {
  return BY_KIND[kind] ?? UNIVERSAL;
}

/**
 * Grades only, with no free-text alongside them.
 *
 * A `notes` field here would break the stored shape - the document holds a plain
 * map of element to grade, and a string among the grades makes the type
 * dishonest. If per-room notes are wanted they belong in their own field rather
 * than smuggled into this one.
 */
export type RoomCondition = Partial<Record<Element, Grade>>;

/**
 * Things that belong to the building rather than to any room.
 *
 * Without these the bill of materials covers interior finishes only, and reads
 * low by construction - the whole-house bands it is checked against include the
 * roof and the systems. A rehab total that quietly omits a $12,000 roof is not
 * a rehab total.
 */
export const HOUSE_ELEMENTS = [
  "roof",
  "exterior",
  "windows",
  "hvac",
  "electrical",
  "plumbing",
  "waterHeater",
  "landscaping",
  "foundation",
] as const;
export type HouseElement = (typeof HOUSE_ELEMENTS)[number];

export type HouseCondition = Partial<Record<HouseElement, Grade>>;

export const HOUSE_ELEMENT_LABEL: Record<HouseElement, string> = {
  roof: "Roof",
  exterior: "Siding & exterior paint",
  windows: "Windows",
  hvac: "Heating & cooling",
  electrical: "Electrical",
  plumbing: "Plumbing",
  waterHeater: "Water heater",
  landscaping: "Yard & landscaping",
  foundation: "Foundation & structure",
};

/** Condition for every room, keyed by room id. */
export type ConditionMap = Record<string, RoomCondition>;

/**
 * The grade an unseen element is treated as.
 *
 * `fair` means "no work", so an unknown element costs nothing and is flagged in
 * the UI instead. Erring towards free and visible beats erring towards
 * expensive and silent - an underestimate someone can see is recoverable, a
 * padded total nobody questions is not.
 */
export const ASSUMED_WHEN_UNSEEN: Grade = "fair";

export function effectiveGrade(grade: Grade | undefined): Grade {
  if (!grade || grade === "not_visible") return ASSUMED_WHEN_UNSEEN;
  return grade;
}

export function isUnknown(grade: Grade | undefined): boolean {
  return !grade || grade === "not_visible";
}

export const GRADE_LABEL: Record<Grade, string> = {
  good: "Good",
  fair: "Fair",
  dated: "Dated",
  poor: "Poor",
  not_visible: "Not seen",
};

export const GRADE_HELP: Record<Grade, string> = {
  good: "Recently done. Nothing needed.",
  fair: "Serviceable. Nothing needed.",
  dated: "Works, but looks wrong. Refresh.",
  poor: "Failing or damaged. Replace.",
  not_visible: "No photo showed it. Costed as fair, and flagged.",
};
