/**
 * What the outside of the house is clad in, from what the site read said.
 *
 * The read returns free text - "wood siding", "asbestos shingle", "brick
 * veneer", "stucco", "board and batten" - and until now that text survived
 * only as a string beside the model. This folds it to the handful of things
 * `textures.ts` can draw. Unknown text is null, and null draws lap siding,
 * which is what most of the houses this is pointed at are wearing.
 */
export type SidingFinish = "lap" | "shingle" | "brick" | "stucco" | "board-and-batten";

const TABLE: Array<[RegExp, SidingFinish]> = [
  [/board\s*(and|&)\s*batten|batten/, "board-and-batten"],
  [/shingle|shake/, "shingle"],
  [/brick|masonry/, "brick"],
  [/stucco|render|plaster|eifs/, "stucco"],
  [/lap|clapboard|siding|vinyl|weatherboard|hardie|fib(er|re)/, "lap"],
];

export function sidingFinish(material: string | null | undefined): SidingFinish | null {
  const text = (material ?? "").toLowerCase();
  if (!text) return null;
  for (const [pattern, finish] of TABLE) if (pattern.test(text)) return finish;
  return null;
}
