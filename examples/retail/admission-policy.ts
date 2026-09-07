/**
 * Retail binding example for the provider-reported delivery gates discussed
 * in UCP #799. This vocabulary is deliberately outside src/core.
 */
import type {
  AdmissionFailure,
  AdmissionRelation,
  MutationProposal,
  MutationQuote,
  RequiredTransition,
  UnitLocator,
} from "../../src/core/types";
import type { AdmissionEvaluator, Quoter } from "../../src/core/reference-provider";

export type RetailOperation = "CANCEL" | "REDEEM";

export interface RetailTransition {
  unitKey: string;
  operation: RetailOperation;
}

export interface RetailChange {
  transitions: RetailTransition[];
}

export interface RetailUnitState {
  kind: "GOODS" | "DELIVERY";
  state: "ACTIVE" | "CANCELLED" | "COMMITTED" | "REDEEMED";
}

export interface RetailOrderState {
  orderId: string;
  version: number;
  units: Record<string, RetailUnitState>;
}

export type RetailStateReader = (orderId: string) => RetailOrderState;

const CANCEL_RELATION = "retail:delivery_cancel_requires_goods_cancel";
const REDEEM_RELATION = "retail:goods_redeem_requires_delivery_redeem";

function readOrderId(proposal: MutationProposal): string {
  const target = proposal.target as { orderId?: unknown };
  if (!target || typeof target.orderId !== "string" || target.orderId.length === 0) {
    throw new Error("Retail proposal target must carry orderId.");
  }
  return target.orderId;
}

export function parseRetailChange(change: unknown): RetailChange {
  const candidate = change as { transitions?: unknown };
  if (!candidate || !Array.isArray(candidate.transitions) || candidate.transitions.length === 0) {
    throw new Error("Retail change must carry a non-empty transitions array.");
  }

  const transitions: RetailTransition[] = [];
  const seen = new Set<string>();
  for (const item of candidate.transitions) {
    const transition = item as { unitKey?: unknown; operation?: unknown };
    if (
      !transition ||
      typeof transition.unitKey !== "string" ||
      transition.unitKey.length === 0 ||
      (transition.operation !== "CANCEL" && transition.operation !== "REDEEM")
    ) {
      throw new Error("Retail transition has an unknown unit or operation.");
    }
    if (seen.has(transition.unitKey)) {
      throw new Error(
        `Retail proposal contains duplicate or contradictory transitions for ${transition.unitKey}.`
      );
    }
    seen.add(transition.unitKey);
    transitions.push({ unitKey: transition.unitKey, operation: transition.operation });
  }
  return { transitions };
}

function scopeRef(orderId: string): string {
  return `retail:${orderId}`;
}

function locator(orderId: string, unitKey: string): UnitLocator {
  return { scopeRef: scopeRef(orderId), unitKey };
}

/**
 * Binding-owned proposal authorization check. MSE does not grant permission
 * merely because an admission witness names an additional transition.
 */
export function isRetailProposalAuthorized(
  proposal: MutationProposal,
  permittedUnitKeys: ReadonlySet<string>
): boolean {
  return parseRetailChange(proposal.change).transitions.every((transition) =>
    permittedUnitKeys.has(transition.unitKey)
  );
}

/**
 * Constructs a new proposal from a COMPLETE witness. It validates binding
 * scope and resolvability and never mutates/reuses the original proposal.
 */
export function amendRetailProposal(
  original: MutationProposal,
  requiredTransitions: RequiredTransition[],
  state: RetailOrderState,
  proposalId: string
): MutationProposal {
  const orderId = readOrderId(original);
  if (orderId !== state.orderId) throw new Error("Retail state does not match proposal target.");

  const originalTransitions = parseRetailChange(original.change).transitions;
  const byUnit = new Map(originalTransitions.map((transition) => [transition.unitKey, transition]));

  for (const required of requiredTransitions) {
    if (required.unitLocator.scopeRef !== scopeRef(orderId)) {
      throw new Error("Required transition is outside the proposal's retail order scope.");
    }
    if (!state.units[required.unitLocator.unitKey]) {
      throw new Error("Required transition refers to an unresolvable retail unit.");
    }
    const transition = required.transition as Partial<RetailTransition>;
    if (
      transition.unitKey !== required.unitLocator.unitKey ||
      (transition.operation !== "CANCEL" && transition.operation !== "REDEEM")
    ) {
      throw new Error("Required transition is malformed or contradicts its unit locator.");
    }
    if (byUnit.has(transition.unitKey)) {
      throw new Error("Required transition duplicates or contradicts an existing transition.");
    }
    byUnit.set(transition.unitKey, transition as RetailTransition);
  }

  return {
    proposalId,
    target: original.target,
    change: { transitions: [...byUnit.values()] } satisfies RetailChange,
  };
}

export function createRetailQuoter(readState: RetailStateReader): Quoter {
  return (proposal) => {
    const orderId = readOrderId(proposal);
    const state = readState(orderId);
    const change = parseRetailChange(proposal.change);
    const scope = scopeRef(orderId);

    for (const transition of change.transitions) {
      if (!state.units[transition.unitKey]) {
        throw new Error(`Retail transition refers to unknown unit ${transition.unitKey}.`);
      }
    }

    const units = change.transitions.map((transition, index) => ({
      unitRef: `${proposal.proposalId}:unit:${index + 1}`,
      unitLocator: locator(orderId, transition.unitKey),
      transition,
      effects: [
        {
          effectId: `${proposal.proposalId}:${transition.unitKey}:cost`,
          type: "retail:transition_cost",
          value: { type: "money" as const, amount: "0.00", currency: "USD" },
          guarantee: { mode: "EXACT" as const },
        },
      ],
    }));

    const unitRefByKey = new Map(
      units.map((unit) => [unit.unitLocator.unitKey, unit.unitRef])
    );
    const relations: AdmissionRelation[] = [];

    const deliveryCancel = change.transitions.find(
      (transition) => transition.unitKey === "delivery" && transition.operation === "CANCEL"
    );
    if (deliveryCancel) {
      relations.push({
        relationId: CANCEL_RELATION,
        type: "REQUIRES_COINCLUSION",
        triggerUnitRefs: [unitRefByKey.get("delivery")!],
        scopeRef: scope,
      });
    }

    const goodsRedeemRefs = change.transitions
      .filter(
        (transition) =>
          transition.operation === "REDEEM" && state.units[transition.unitKey]?.kind === "GOODS"
      )
      .map((transition) => unitRefByKey.get(transition.unitKey)!);
    if (goodsRedeemRefs.length > 0) {
      relations.push({
        relationId: REDEEM_RELATION,
        type: "REQUIRES_COINCLUSION",
        triggerUnitRefs: goodsRedeemRefs,
        scopeRef: scope,
      });
    }

    return {
      target: proposal.target,
      snapshot: { orderVersion: state.version },
      commitConsistency: "SNAPSHOT_REQUIRED",
      units,
      admissionRelations: relations,
    };
  };
}

function requiredTransition(
  orderId: string,
  unitKey: string,
  operation: RetailOperation
): RequiredTransition {
  return {
    unitLocator: locator(orderId, unitKey),
    transition: { unitKey, operation } satisfies RetailTransition,
  };
}

/** Evaluates the two provider-reported delivery gates against current state. */
export function createRetailAdmissionEvaluator(readState: RetailStateReader): AdmissionEvaluator {
  return (proposal, quote) => {
    const orderId = readOrderId(proposal);
    const state = readState(orderId);
    const transitions = parseRetailChange(proposal.change).transitions;
    const transitionByUnit = new Map(transitions.map((transition) => [transition.unitKey, transition]));
    const failures: AdmissionFailure[] = [];

    for (const relation of quote.admissionRelations) {
      if (relation.relationId !== CANCEL_RELATION && relation.relationId !== REDEEM_RELATION) {
        throw new Error("Unsupported retail admission relation.");
      }
      if (relation.relationId === CANCEL_RELATION) {
        const requiredGoods = Object.entries(state.units)
          .filter(([, unitState]) => unitState.kind === "GOODS" && unitState.state !== "CANCELLED")
          .map(([unitKey]) => unitKey);

        const contradictory = requiredGoods.some((unitKey) => {
          const included = transitionByUnit.get(unitKey);
          return included !== undefined && included.operation !== "CANCEL";
        });
        if (contradictory) {
          failures.push({
            relationId: relation.relationId,
            witness: { disposition: "NOT_REPAIRABLE" },
          });
          continue;
        }

        const missing = requiredGoods
          .filter((unitKey) => transitionByUnit.get(unitKey)?.operation !== "CANCEL")
          .map((unitKey) => requiredTransition(orderId, unitKey, "CANCEL"));
        if (missing.length > 0) {
          failures.push({
            relationId: relation.relationId,
            witness: { disposition: "COMPLETE", requiredTransitions: missing },
          });
        }
      }

      if (relation.relationId === REDEEM_RELATION) {
        const delivery = state.units.delivery;
        if (!delivery) {
          failures.push({
            relationId: relation.relationId,
            witness: { disposition: "UNAVAILABLE" },
          });
          continue;
        }
        if (delivery.state !== "COMMITTED") continue;

        const included = transitionByUnit.get("delivery");
        if (included && included.operation !== "REDEEM") {
          failures.push({
            relationId: relation.relationId,
            witness: { disposition: "NOT_REPAIRABLE" },
          });
        } else if (!included) {
          failures.push({
            relationId: relation.relationId,
            witness: {
              disposition: "COMPLETE",
              requiredTransitions: [requiredTransition(orderId, "delivery", "REDEEM")],
            },
          });
        }
      }
    }

    // Both supported rules above have actually been evaluated; absence of a
    // failure here means this binding observed no failure, not early stopping.
    const coverage = quote.admissionRelations.map(relation => ({
      relationId: relation.relationId,
      status: failures.some(f => f.relationId === relation.relationId)
        ? "FAILED" as const : "PASSED" as const,
    }));
    return { stateRef: { orderVersion: state.version }, failures, coverage };
  };
}

export function retailSnapshot(state: RetailOrderState): unknown {
  return { orderVersion: state.version };
}

