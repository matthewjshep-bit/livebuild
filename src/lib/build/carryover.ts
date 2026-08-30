import type { Grade } from "@/lib/bom/condition";
import type { Plan, Property } from "@/lib/schema";

/**
 * Keep the grading when a re-layout renames every room.
 *
 * A new layout mints new room ids, and `condition` is keyed by room id - so
 * re-deriving a plan silently threw away every grade somebody had entered by
 * hand, and with it the scope of work and the price. Nodes were already
 * re-placed for this exact reason; condition was not, and the loss was
 * invisible until the scope page came back reading "nothing seen yet".
 *
 * Matching is by label, which is the only thing that survives a re-layout and
 * is also what the user thinks the grade belongs to: they graded *the kitchen*,
 * not room `r7`. Where a label is ambiguous - two rooms called "Bedroom" - the
 * pairing follows the order they appear on their storey, which is stable and no
 * worse than any other guess.
 */
export function carryCondition(
  before: Plan,
  after: Plan,
  condition: Property["condition"],
): { condition: Property["condition"]; carried: number; lost: string[] } {
  const graded = new Set(Object.keys(condition).filter((id) => Object.keys(condition[id] ?? {}).length > 0));
  if (graded.size === 0) return { condition: {}, carried: 0, lost: [] };

  const queueFor = (plan: Plan) => {
    const byLabel = new Map<string, string[]>();
    for (const room of plan.rooms) {
      const key = room.label.trim().toLowerCase();
      if (!byLabel.has(key)) byLabel.set(key, []);
      byLabel.get(key)!.push(room.id);
    }
    return byLabel;
  };

  const destinations = queueFor(after);
  const next: Record<string, Record<string, Grade>> = {};
  const lost: string[] = [];
  let carried = 0;

  for (const room of before.rooms) {
    const grades = condition[room.id];
    if (!grades || Object.keys(grades).length === 0) continue;

    const candidates = destinations.get(room.label.trim().toLowerCase());
    const target = candidates?.shift();
    if (!target) {
      lost.push(room.label);
      continue;
    }
    // Two rooms of the same name could both map here; merge rather than clobber.
    next[target] = { ...(next[target] ?? {}), ...grades };
    carried++;
  }

  return { condition: next, carried, lost };
}
