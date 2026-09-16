/**
 * Retail binding example for the provider-reported delivery gates discussed
 * in UCP #799. This vocabulary is deliberately outside src/core.
 */
import type {
  AdmissionCoverage,
  AdmissionFailure,
  AdmissionReport,
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
  transitionHistory?: RetailTransitionRecord[];
}

export type RetailTransitionRecord =
  | {
      status: "SUBMITTED" | "PENDING" | "FAILED";
      transitionRef: string;
      transition: RetailTransition;
      finalizedAt?: never;
    }
  | {
      status: "FINAL";
      transitionRef: string;
      transition: RetailTransition;
      finalizedAt: string;
    };

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
        ...(Object.values(state.units).some(unit => unit.kind === "GOODS")
          ? { passEvidence: "REQUIRED" as const }
          : {}),
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
        passEvidence: "REQUIRED",
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
    const coverage: AdmissionCoverage[] = [];

    const currentSatisfaction = (unitKey: string, transition: RetailTransition) => {
      const unit = quote.units.find(candidate => candidate.unitLocator.unitKey === unitKey);
      if (!unit) throw new Error(`Current retail transition ${unitKey} is absent from its quote.`);
      return {
        source: "CURRENT_REQUEST" as const,
        unitRef: unit.unitRef,
        transition,
      };
    };
    const priorFinalSatisfaction = (unitKey: string, operation: RetailOperation) => {
      const record = state.units[unitKey]?.transitionHistory?.find(candidate =>
        candidate.status === "FINAL" &&
        candidate.transition.unitKey === unitKey &&
        candidate.transition.operation === operation
      );
      if (!record || record.status !== "FINAL") return undefined;
      return {
        source: "PRIOR_FINAL_TRANSITION" as const,
        unitLocator: locator(orderId, unitKey),
        transition: record.transition,
        transitionRef: record.transitionRef,
        finalizedAt: record.finalizedAt,
      };
    };

    for (const relation of quote.admissionRelations) {
      if (relation.relationId !== CANCEL_RELATION && relation.relationId !== REDEEM_RELATION) {
        throw new Error("Unsupported retail admission relation.");
      }
      if (relation.relationId === CANCEL_RELATION) {
        const requiredGoods = Object.entries(state.units)
          .filter(([, unitState]) => unitState.kind === "GOODS")
          .map(([unitKey]) => unitKey);
        const satisfactions = [] as NonNullable<Extract<AdmissionCoverage, { status: "PASSED" }>["satisfactions"]>;
        const missing: RequiredTransition[] = [];
        let contradictory = false;
        for (const unitKey of requiredGoods) {
          const included = transitionByUnit.get(unitKey);
          if (included?.operation === "CANCEL") {
            satisfactions.push(currentSatisfaction(unitKey, included));
          } else if (included) {
            contradictory = true;
          } else {
            const prior = priorFinalSatisfaction(unitKey, "CANCEL");
            if (prior) satisfactions.push(prior);
            else missing.push(requiredTransition(orderId, unitKey, "CANCEL"));
          }
        }
        if (contradictory) {
          failures.push({
            relationId: relation.relationId,
            witness: { disposition: "NOT_REPAIRABLE" },
          });
          coverage.push({ relationId: relation.relationId, status: "FAILED" });
          continue;
        }
        if (missing.length > 0) {
          failures.push({
            relationId: relation.relationId,
            witness: { disposition: "COMPLETE", requiredTransitions: missing },
          });
          coverage.push({ relationId: relation.relationId, status: "FAILED" });
        } else {
          coverage.push({
            relationId: relation.relationId,
            status: "PASSED",
            ...(satisfactions.length > 0 ? { satisfactions } : {}),
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
          coverage.push({ relationId: relation.relationId, status: "FAILED" });
          continue;
        }
        const included = transitionByUnit.get("delivery");
        if (included && included.operation !== "REDEEM") {
          failures.push({
            relationId: relation.relationId,
            witness: { disposition: "NOT_REPAIRABLE" },
          });
          coverage.push({ relationId: relation.relationId, status: "FAILED" });
        } else if (included) {
          coverage.push({
            relationId: relation.relationId,
            status: "PASSED",
            satisfactions: [currentSatisfaction("delivery", included)],
          });
        } else {
          const prior = priorFinalSatisfaction("delivery", "REDEEM");
          if (prior) {
            coverage.push({
              relationId: relation.relationId,
              status: "PASSED",
              satisfactions: [prior],
            });
            continue;
          }
          failures.push({
            relationId: relation.relationId,
            witness: {
              disposition: "COMPLETE",
              requiredTransitions: [requiredTransition(orderId, "delivery", "REDEEM")],
            },
          });
          coverage.push({ relationId: relation.relationId, status: "FAILED" });
        }
      }
    }
    return { stateRef: { orderVersion: state.version }, failures, coverage };
  };
}

/**
 * Retail trace conformance: unlike core validation, this re-evaluates the
 * opaque retail history and therefore detects structurally valid false claims.
 */
export function assertRetailAdmissionTrace(
  proposal: MutationProposal,
  quote: MutationQuote,
  report: AdmissionReport,
  state: RetailOrderState
): void {
  const expected = createRetailAdmissionEvaluator(() => state)(proposal, quote, new Date(report.evaluatedAt));
  const sortByJson = <T>(value: T[]) => [...value].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b))
  );
  const normalizeCoverage = (value: AdmissionCoverage[]) => sortByJson(value.map(entry =>
    entry.status === "PASSED" && entry.satisfactions
      ? { ...entry, satisfactions: sortByJson(entry.satisfactions) }
      : entry
  ));
  if (JSON.stringify(normalizeCoverage(report.coverage)) !==
        JSON.stringify(normalizeCoverage(expected.coverage)) ||
      JSON.stringify(sortByJson(report.failures)) !== JSON.stringify(sortByJson(expected.failures))) {
    throw new Error("Admission report contradicts the retail binding evaluation trace.");
  }
}

export function retailSnapshot(state: RetailOrderState): unknown {
  return { orderVersion: state.version };
}
