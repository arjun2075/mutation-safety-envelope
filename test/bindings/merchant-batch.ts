/** Test-only merchant binding. Each order retains its own locator scope. */
import type { AdmissionFailure, MutationProposal, RequiredTransition } from "../../src/core/types";
import type { Quoter } from "../../src/core/reference-provider";

export const orders = ["A", "B", "C"];
export const scope = (order: string) => `merchant:M:order:${order}`;
export type Item = { order: string; unitKey: string; operation: "REDEEM" };
export const initial = (): MutationProposal => ({
  proposalId: "batch-0", target: { merchantId: "M" },
  change: orders.map(order => ({ order, unitKey: "goods", operation: "REDEEM" })),
});
export function items(proposal: MutationProposal): Item[] {
  if ((proposal.target as { merchantId: string }).merchantId !== "M") throw Error("Wrong merchant");
  const result = proposal.change as Item[];
  const seen = new Set<string>();
  for (const item of result) {
    if (!orders.includes(item.order) || !["goods", "delivery"].includes(item.unitKey) || item.operation !== "REDEEM") throw Error("Invalid transition");
    const key = `${item.order}:${item.unitKey}`;
    if (seen.has(key)) throw Error("Duplicate or contradictory transition");
    seen.add(key);
  }
  return result;
}
export const quoter: Quoter = proposal => {
  const units = items(proposal).map((item, i) => ({
    unitRef: `${proposal.proposalId}:${i}`, unitLocator: { scopeRef: scope(item.order), unitKey: item.unitKey },
    transition: item, effects: [{ effectId: `${proposal.proposalId}:${i}:cost`, type: "batch:cost",
      value: { type: "number" as const, value: 0 }, guarantee: { mode: "EXACT" as const } }],
  }));
  return { target: proposal.target, units, admissionRelations: orders.map(order => ({
    relationId: `requires:${order}`, type: "REQUIRES_COINCLUSION", scopeRef: scope(order),
    triggerUnitRefs: units.filter(u => u.unitLocator.scopeRef === scope(order) && u.unitLocator.unitKey === "goods").map(u => u.unitRef),
  })) };
};
export function evaluate(proposal: MutationProposal, failFast = false, committed = new Set(orders)) {
  const submitted = items(proposal);
  const failures: AdmissionFailure[] = [];
  const visited: string[] = [];
  for (const order of orders) {
    visited.push(`requires:${order}`);
    if (committed.has(order) && !submitted.some(t => t.order === order && t.unitKey === "delivery")) {
      failures.push({ relationId: `requires:${order}`, witness: { disposition: "COMPLETE", requiredTransitions: [{
        unitLocator: { scopeRef: scope(order), unitKey: "delivery" },
        transition: { order, unitKey: "delivery", operation: "REDEEM" },
      }] } });
      if (failFast) break;
    }
  }
  return { failures, visited };
}
export function amend(original: MutationProposal, required: RequiredTransition[], id: string): MutationProposal {
  const additions = required.map(r => {
    const item = r.transition as Item;
    if (r.unitLocator.scopeRef !== scope(item.order) || r.unitLocator.unitKey !== item.unitKey) throw Error("Wrong order attribution");
    return item;
  });
  const proposal = { ...original, proposalId: id, change: [...items(original), ...additions] };
  items(proposal);
  return proposal;
}
export const authorized = (proposal: MutationProposal, allowed: Set<string>) =>
  items(proposal).every(t => allowed.has(`${t.order}:${t.unitKey}`));
