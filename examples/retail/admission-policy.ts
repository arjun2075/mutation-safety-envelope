/**
 * Retail binding example for the provider-reported delivery gates discussed
 * in UCP #799. This vocabulary is deliberately outside src/core.
 */
import type {
  AdmissionCoverage,
  AdmissionFailure,
  AdmissionSatisfaction,
  AdmissionReport,
  AdmissionRelation,
  MutationProposal,
  MutationQuote,
  AdmissionRequiredParticipant,
  RequiredTransition,
  UnitLocator,
} from "../../src/core/types";
import type { AdmissionEvaluator, Quoter } from "../../src/core/reference-provider";
import { canonicalJson, isIsoDateTime } from "../../src/core/validate";

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

function requiredParticipant(
  orderId: string,
  unitKey: string,
  operation: RetailOperation
): AdmissionRequiredParticipant {
  return {
    unitLocator: locator(orderId, unitKey),
    transition: { unitKey, operation } satisfies RetailTransition,
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

/**
 * EVIDENCE SELECTION (retail binding contract).
 *
 * Under historical coexistence a required participant may be satisfied two
 * ways at once: a valid prior final occurrence already satisfies the
 * relation, and the same transition is present again in the current
 * request. The wire contract permits only one satisfaction record per
 * binding-scoped participant, so the binding must choose.
 *
 * This binding PREFERS valid `PRIOR_FINAL_TRANSITION` evidence over a
 * redundant `CURRENT_REQUEST` satisfaction for the same participant, and
 * uses current-request evidence only when no semantically sufficient prior
 * occurrence exists.
 *
 * Rationale: a redundant current attempt can still end `REFUSED` or
 * `INDETERMINATE` even though the relation was already satisfied
 * historically. Citing the already-final occurrence keeps both the
 * admission explanation and the post-commit realization stable, instead of
 * reporting NOT_REALIZED for a relation that was in fact satisfied before
 * the request began.
 *
 * This is a binding canonicalization, not a generic MSE rule. Trace
 * conformance enforces it so the oracle compares against a defined
 * canonical representation.
 */
type RetailFinalRecord = Extract<RetailTransitionRecord, { status: "FINAL" }>;

/**
 * `transitionRef` identity (retail binding contract).
 *
 * Model B relies on `transitionRef` distinguishing historical occurrences,
 * so within one binding-scoped unit a `transitionRef` MUST identify exactly
 * one historical transition occurrence. A history that reuses a ref for two
 * records makes the cited occurrence ambiguous, and an ambiguous citation
 * cannot be authenticated. This binding therefore fails closed.
 *
 * Scope is `(unitLocator, transitionRef)`. The core protocol does not
 * declare `transitionRef` globally scoped, so uniqueness is NOT asserted
 * across unrelated units.
 */
export function assertRetailTransitionRefsUnique(state: RetailOrderState): void {
  for (const [unitKey, unitState] of Object.entries(state.units)) {
    const seen = new Map<string, RetailTransitionRecord>();
    for (const record of unitState.transitionHistory ?? []) {
      const existing = seen.get(record.transitionRef);
      if (existing) {
        throw new Error(
          `Retail unit ${unitKey} reuses transitionRef "${record.transitionRef}" for more than ` +
            `one historical occurrence; a transitionRef must identify exactly one occurrence ` +
            `within a unit.`
        );
      }
      seen.set(record.transitionRef, record);
    }
  }
}

/**
 * Canonical historical selection (retail binding contract).
 *
 * A candidate qualifies only when it is FINAL, its transition matches the
 * required retail transition, its `finalizedAt` satisfies the SAME ISO
 * date-time contract core enforces, and its instant is at or before the
 * evaluation instant. Qualifying on `isIsoDateTime` rather than bare
 * `Date.parse` matters: a date-only string like "2026-09-18" parses in
 * JavaScript but is not a date-time, so selecting it would emit evidence
 * that core then rejects.
 *
 * When several distinct occurrences qualify, this binding canonicalizes on
 * the GREATEST finalization instant, with ordinal `transitionRef` as
 * tiebreak. That choice is a retail/reference-binding canonicalization, NOT
 * a generic MSE requirement: the core protocol does not say which of
 * several truthful occurrences a binding must cite. Trace conformance
 * enforces this rule deliberately, so the oracle compares against a defined
 * canonical representation rather than rejecting another truthful witness
 * by accident.
 */
export function selectRetailPriorFinal(
  state: RetailOrderState,
  unitKey: string,
  operation: RetailOperation,
  evaluatedAtMs: number
): RetailFinalRecord | undefined {
  const qualifying = (state.units[unitKey]?.transitionHistory ?? []).filter(
    (candidate): candidate is RetailFinalRecord =>
      candidate.status === "FINAL" &&
      candidate.transition.unitKey === unitKey &&
      candidate.transition.operation === operation &&
      isIsoDateTime(candidate.finalizedAt) &&
      Date.parse(candidate.finalizedAt) <= evaluatedAtMs
  );
  if (qualifying.length === 0) return undefined;
  return [...qualifying].sort((left, right) => {
    const byInstant = Date.parse(right.finalizedAt) - Date.parse(left.finalizedAt);
    if (byInstant !== 0) return byInstant;
    // Ordinal, not locale collation.
    return left.transitionRef < right.transitionRef
      ? -1
      : left.transitionRef > right.transitionRef
        ? 1
        : 0;
  })[0];
}

/** Evaluates the two provider-reported delivery gates against current state. */
export function createRetailAdmissionEvaluator(readState: RetailStateReader): AdmissionEvaluator {
  return (proposal, quote, now) => {
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
    // Evaluation-time filter. A history record qualifies only when it is
    // FINAL, matches the required retail transition, AND finalized at or
    // before the evaluation instant. A record finalized in the future
    // relative to this pass is not history yet: emitting it as admission
    // evidence would both misstate the gate and produce a report core
    // rejects for finalizedAt > evaluatedAt (spec §3.2).
    //
    // Selection is deterministic and scans ALL matching records, so an
    // earlier array element with a future finalizedAt cannot hide a later
    // valid one. Among qualifying records the latest finalization wins,
    // ties broken by transitionRef, so the choice does not depend on
    // array order.
    const evaluatedAtMs = now.getTime();
    assertRetailTransitionRefsUnique(state);
    const priorFinalSatisfaction = (unitKey: string, operation: RetailOperation) => {
      const record = selectRetailPriorFinal(state, unitKey, operation, evaluatedAtMs);
      if (!record) return undefined;
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
          if (included && included.operation !== "CANCEL") {
            contradictory = true;
            continue;
          }
          // Evidence-source precedence (see EVIDENCE SELECTION above):
          // already-final history wins over a redundant current attempt.
          const prior = priorFinalSatisfaction(unitKey, "CANCEL");
          if (prior) satisfactions.push(prior);
          else if (included) satisfactions.push(currentSatisfaction(unitKey, included));
          else missing.push(requiredTransition(orderId, unitKey, "CANCEL"));
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
            ...(requiredGoods.length > 0
              ? {
                  requiredParticipants: requiredGoods.map(unitKey =>
                    requiredParticipant(orderId, unitKey, "CANCEL")
                  ),
                }
              : {}),
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
          continue;
        }
        // Evidence-source precedence: prefer already-final history.
        const prior = priorFinalSatisfaction("delivery", "REDEEM");
        const chosen = prior ?? (included ? currentSatisfaction("delivery", included) : undefined);
        if (chosen) {
          coverage.push({
            relationId: relation.relationId,
            status: "PASSED",
            satisfactions: [chosen],
            requiredParticipants: [requiredParticipant(orderId, "delivery", "REDEEM")],
          });
        } else {
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
 * opaque retail history and therefore detects structurally valid false
 * claims that the domain-blind core cannot disprove.
 *
 * The comparison must be SEMANTIC, not serialization-wise. Two properties
 * matter and they are different:
 *
 *  - Opaque values (transitions, witnesses, stateRef) carry no significance
 *    in their object member order, so they are compared through
 *    `canonicalJson`, which recursively sorts object keys while preserving
 *    array order. `stateRef` is included: this binding emits the evaluated
 *    order version, and a report claiming a different one misdescribes the
 *    state the gates were evaluated against. The pre-repair comparator
 *    omitted it, so a forged stateRef passed trace conformance.
 *  - Protocol arrays whose semantics are SETS — coverage entries,
 *    satisfactions, requiredParticipants, dependsOn, failures — carry no
 *    significance in their position, so they are normalized by membership
 *    (sorted on their own canonical keys) rather than compared elementwise.
 *
 * Collapsing these two into one raw `JSON.stringify` comparison, as an
 * earlier revision did, made both a reordered participant list and a
 * reordered transition object look like a contradiction.
 */
export function assertRetailAdmissionTrace(
  proposal: MutationProposal,
  quote: MutationQuote,
  report: AdmissionReport,
  state: RetailOrderState
): void {
  const expected = createRetailAdmissionEvaluator(() => state)(proposal, quote, new Date(report.evaluatedAt));

  /**
   * Membership normalization for a set-like protocol array.
   *
   * Uses the default sort, which orders by UTF-16 code unit. That is
   * deliberate: canonical ordering MUST NOT depend on machine locale or
   * Unicode collation, so `localeCompare` is not used here. Cardinality is
   * preserved — sorting never deduplicates — so a duplicated element still
   * makes two reports differ.
   */
  const asSet = <T>(value: readonly T[] | undefined): string[] =>
    (value ?? []).map(canonicalJson).sort();

  /**
   * Normalizes one satisfaction record.
   *
   * `finalizedAt` is a KNOWN, typed timestamp field, so it is compared by
   * parsed instant rather than by lexical spelling: `2026-09-18T12:00:00Z`
   * and `2026-09-18T05:00:00-07:00` denote the same historical
   * finalization fact, and core already compares this field as an instant
   * (spec §3.2). A binding that rejected one spelling while core accepted
   * it would disagree with the contract it is meant to substantiate.
   *
   * This is deliberately narrow. `canonicalJson` still MUST NOT guess that
   * arbitrary opaque strings are timestamps; only this one declared field
   * is interpreted, and only because the protocol types it as a date-time.
   */
  const normalizeSatisfaction = (satisfaction: AdmissionSatisfaction): unknown => {
    if (satisfaction.source !== "PRIOR_FINAL_TRANSITION") return satisfaction;
    const instant = Date.parse(satisfaction.finalizedAt);
    return {
      ...satisfaction,
      // Malformed values keep their lexical form so a difference still
      // shows up rather than collapsing to NaN.
      finalizedAt: Number.isNaN(instant) ? satisfaction.finalizedAt : instant,
    };
  };

  /**
   * One coverage entry reduced to its semantic content: status, plus the
   * set-normalized collections it may carry. Array position never survives.
   */
  const normalizeEntry = (entry: AdmissionCoverage): string => {
    const base: Record<string, unknown> = {
      relationId: entry.relationId,
      status: entry.status,
    };
    if (entry.status === "PASSED") {
      base.satisfactions = asSet((entry.satisfactions ?? []).map(normalizeSatisfaction));
      base.requiredParticipants = asSet(entry.requiredParticipants);
    } else if (entry.status === "DEFERRED") {
      base.dependsOn = [...entry.dependsOn].sort();
    }
    return canonicalJson(base);
  };

  const normalizeCoverage = (value: AdmissionCoverage[]) => value.map(normalizeEntry).sort();

  /**
   * One failure reduced to its semantic content. `witness.requiredTransitions`
   * is a SET of units that must be added to repair the relation: it names
   * what is missing, not an order to add them in (spec §3.2), so its
   * position is normalized away like every other set-like array here.
   */
  const normalizeFailure = (failure: AdmissionFailure): string => {
    const witness = failure.witness;
    const base: Record<string, unknown> = {
      relationId: failure.relationId,
      disposition: witness.disposition,
    };
    if (witness.disposition === "COMPLETE" || witness.disposition === "PARTIAL") {
      base.requiredTransitions = asSet(witness.requiredTransitions);
    }
    return canonicalJson(base);
  };

  const coverageMatches =
    canonicalJson(normalizeCoverage(report.coverage)) ===
    canonicalJson(normalizeCoverage(expected.coverage));
  const failuresMatch =
    canonicalJson(report.failures.map(normalizeFailure).sort()) ===
    canonicalJson(expected.failures.map(normalizeFailure).sort());
  // stateRef is opaque, so compare it canonically rather than by identity.
  const stateRefMatches = canonicalJson(report.stateRef) === canonicalJson(expected.stateRef);

  if (!coverageMatches || !failuresMatch || !stateRefMatches) {
    throw new Error("Admission report contradicts the retail binding evaluation trace.");
  }
}

export function retailSnapshot(state: RetailOrderState): unknown {
  return { orderVersion: state.version };
}
