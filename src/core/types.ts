/**
 * Mutation Safety Envelope (MSE) — core types, v0.2.0.
 *
 * This file is a TypeScript mirror of /schema/mse-core.schema.json.
 * The JSON Schema is normative; this file exists for ergonomic use in
 * TypeScript reference implementations and MUST be kept in sync with it.
 * If the two ever disagree, the JSON Schema wins (see /spec/normative-spec.md).
 *
 * Nothing in this file may reference a domain vocabulary (SKU, fare, plan,
 * billing period, seat, refund rule, etc.). Domain vocabulary belongs in
 * /examples/<domain>, not here.
 *
 * v0.2.0 is a breaking revision of v0.1.0's mutation-wide CommitOutcome
 * model, in direct response to external falsification — see
 * /docs/v0.2-review-response.md and /spec/normative-spec.md.
 */

/** Confidence classification for a predicted effect. */
export type GuaranteeMode = "EXACT" | "REVALIDATE" | "UNKNOWN";

export interface Guarantee {
  mode: GuaranteeMode;
  /** ISO 8601 timestamp. Must be absent when mode is UNKNOWN. */
  validUntil?: string;
}

/** A namespaced, domain-defined consequence of a mutation. */
export interface Effect {
  /**
   * Opaque, domain-blind identifier for this specific effect instance,
   * unique within the MutationQuote it appears in (across all units).
   * Added in v0.2.0 — see /spec/normative-spec.md §7a for why `type` alone
   * is no longer sufficient once multiple units can share an effect type.
   */
  effectId: string;
  /** `<namespace>:<local_name>`, e.g. "retail:order_total_delta". Opaque to the core. Not required to be unique — see effectId. */
  type: string;
  /**
   * Domain-defined payload. Opaque to the core in general. A profile MAY
   * (but need not) shape this as a ComparableValue when it wants the effect
   * to be usable in an AcceptanceConstraint — see ComparableValue.
   */
  value: unknown;
  guarantee: Guarantee;
}

export type CommitConsistency = "SNAPSHOT_REQUIRED" | "SNAPSHOT_ADVISORY" | "NONE";

/** Describes the target resource and an opaque proposed change. */
export interface MutationProposal {
  proposalId: string;
  /** Opaque reference to the resource being mutated. */
  target: unknown;
  /** Opaque, domain-defined description of the proposed change. */
  change: unknown;
}

/**
 * Added in v0.2.0. A domain-blind representation of one independently
 * committing unit within a MutationQuote. The core assigns no meaning to
 * what a unit is — see /spec/normative-spec.md §1a.
 */
export interface CommittingUnit {
  /** Opaque, stable identifier for this unit, unique within the quote. */
  unitRef: string;
  /** Predicted consequences of committing this specific unit. MAY be empty. */
  effects: Effect[];
}

/** A non-mutating representation of the predicted consequences of a proposal. */
export interface MutationQuote {
  quoteId: string;
  target: unknown;
  /** Opaque reference/hash of target's state at quote time, if offered. */
  snapshot?: unknown;
  /**
   * Added in v0.2.0, replacing v0.1.0's top-level `effects` array. The
   * complete set of independently committing units, known no later than
   * quote time. MUST be non-empty; every unitRef MUST be unique.
   */
  units: CommittingUnit[];
  /** ISO 8601 timestamp after which this quote must not be committed. */
  expiresAt?: string;
  commitConsistency?: CommitConsistency;
}

export type ComparisonOperator = "<=" | ">=" | "==" | "!=";

/**
 * A discriminated, domain-blind comparable value. This is a closed set of
 * generic value SHAPES, not domain concepts — see /spec/normative-spec.md §4a
 * for why a `money` variant does not violate core domain-blindness.
 */
export type ComparableValue =
  | { type: "number"; value: number }
  | { type: "money"; amount: string; currency: string }
  | { type: "timestamp"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "string"; value: string };

/**
 * A principal/agent-defined bound checked against the final pre-commit quote.
 * Changed in v0.2.0: identifies the target effect by `effectId` (was
 * `effectType`), since multiple units may produce effects of the same type.
 */
export interface AcceptanceConstraint {
  effectId: string;
  operator: ComparisonOperator;
  value: ComparableValue;
}

export interface CommitRequest {
  quoteId: string;
  /**
   * Opaque key reserved for caller-driven retry safety and, as of v0.2.0,
   * usable as a Reconciliation correlation key. MSE does not define the
   * retry protocol; per-unit reconciliation (not blind resubmission) is
   * the normative resolution mechanism for INDETERMINATE — see
   * /spec/normative-spec.md §4a-§4b.
   */
  idempotencyKey?: string;
  acceptanceConstraints: AcceptanceConstraint[];
}

/**
 * Renamed from CommitOutcome in v0.2.0 and now scoped to a single
 * CommittingUnit rather than to the whole mutation attempt.
 */
export type UnitOutcome = "APPLIED" | "REFUSED" | "INDETERMINATE";

/**
 * Five standard reasons, or a namespaced extension `<namespace>:<local_reason>`
 * (e.g. "travel:fare_class_closed"). See /spec/normative-spec.md §5.
 */
export type RefusalReason =
  | "QUOTE_EXPIRED"
  | "SNAPSHOT_MISMATCH"
  | "CONSTRAINT_VIOLATED"
  | "GUARANTEE_UNKNOWN_AT_COMMIT"
  | "PROVIDER_REJECTED"
  | (string & {});

/**
 * Added in v0.2.0. Classifies what kind of path, if any, exists to resolve
 * an INDETERMINATE UnitResult. See /spec/normative-spec.md §4b.
 */
export type ReconciliationMode = "MACHINE_RESOLVABLE" | "AUTHORITATIVE_READ" | "NONE";

/**
 * Added in v0.2.0. Carried on an INDETERMINATE UnitResult so a binding can
 * tell the caller what safe operation comes next, without MSE itself
 * defining a transport or retry protocol.
 */
export interface Reconciliation {
  mode: ReconciliationMode;
  /**
   * Required when mode is MACHINE_RESOLVABLE or AUTHORITATIVE_READ; MUST be
   * absent when mode is NONE. Correlates a future reconciliation/read
   * attempt back to this specific indeterminate attempt (and, transitively,
   * to the unitRef it resolves).
   */
  correlationId?: string;
  /**
   * Opaque, binding-defined pointer describing how to invoke the
   * reconciliation or authoritative-read path. The core does not interpret
   * this value.
   */
  reference?: unknown;
}

/**
 * Added in v0.2.0, replacing v0.1.0's mutation-wide outcome/refusalReason/
 * committedEffects on CommitResult. One UnitResult per CommittingUnit in
 * the originating quote.
 */
export interface UnitResult {
  /** MUST match the unitRef of exactly one CommittingUnit in the referenced quote. */
  unitRef: string;
  outcome: UnitOutcome;
  /** Required when outcome is REFUSED for this unit. */
  refusalReason?: RefusalReason;
  /**
   * Present when this unit's outcome is APPLIED. MUST be absent when
   * outcome is REFUSED or INDETERMINATE — an INDETERMINATE unit in
   * particular MUST NOT claim committedEffects, because the provider does
   * not know whether they occurred.
   */
  committedEffects?: Effect[];
  /** Required when outcome is INDETERMINATE for this unit; MUST be absent otherwise. */
  reconciliation?: Reconciliation;
}

/**
 * Added in v0.2.0. A non-authoritative, derived-only summary of
 * CommitResult.unitResults. NOT AUTHORITATIVE — a caller MUST NOT collapse
 * a MIXED result into any single outcome decision based on this field
 * alone. See /spec/normative-spec.md §1c.
 */
export type AggregateHint = "ALL_APPLIED" | "ALL_REFUSED" | "ALL_INDETERMINATE" | "MIXED";

export interface CommitResult {
  quoteId: string;
  /**
   * Changed in v0.2.0 (replaces the v0.1.0 mutation-wide `outcome`/
   * `refusalReason`/`committedEffects` fields entirely). MUST contain
   * exactly one UnitResult per CommittingUnit present in the referenced
   * quote — complete coverage, no silent omission. See
   * /spec/normative-spec.md §1b.
   */
  unitResults: UnitResult[];
  /** Non-authoritative derived summary; see AggregateHint. */
  aggregateHint?: AggregateHint;
}

export type EffectFinalityState = "FINAL" | "PENDING" | "FAILED" | "UNKNOWN";

/**
 * Changed in v0.2.0: correlates by `effectId` (was `effectType`), and
 * carries `unitRef` so a receipt is self-describing.
 */
export interface EffectReceipt {
  effectId: string;
  unitRef: string;
  finality: EffectFinalityState;
  /** Domain-defined realized value, when known. */
  value?: unknown;
  /** ISO 8601 timestamp; present once finality is FINAL or FAILED. */
  settledAt?: string;
}

export interface Receipt {
  quoteId: string;
  /**
   * Changed in v0.2.0: the v0.1.0 mutation-wide `mutationOutcome` field is
   * removed entirely — commit-unit determinacy is fully carried by the
   * corresponding CommitResult.unitResults, and must not be re-collapsed
   * here. MUST contain exactly one entry per effect in every APPLIED
   * unit's committedEffects — an effect must not silently disappear. An
   * untrackable effect MUST still appear, with finality UNKNOWN, rather
   * than being omitted. See /spec/normative-spec.md §6a.
   */
  effectReceipts: EffectReceipt[];
}
