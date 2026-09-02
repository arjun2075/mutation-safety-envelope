/**
 * Mutation Safety Envelope (MSE) — core types, v0.1.0.
 *
 * This file is a TypeScript mirror of /schema/mse-core.schema.json.
 * The JSON Schema is normative; this file exists for ergonomic use in
 * TypeScript reference implementations and MUST be kept in sync with it.
 * If the two ever disagree, the JSON Schema wins (see /spec/normative-spec.md).
 *
 * Nothing in this file may reference a domain vocabulary (SKU, fare, plan,
 * billing period, seat, refund rule, etc.). Domain vocabulary belongs in
 * /examples/<domain>, not here.
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
  /** `<namespace>:<local_name>`, e.g. "retail:order_total_delta". Opaque to the core. */
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

/** A non-mutating representation of the predicted consequences of a proposal. */
export interface MutationQuote {
  quoteId: string;
  target: unknown;
  /** Opaque reference/hash of target's state at quote time, if offered. */
  snapshot?: unknown;
  effects: Effect[];
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

/** A principal/agent-defined bound checked against the final pre-commit quote. */
export interface AcceptanceConstraint {
  effectType: string;
  operator: ComparisonOperator;
  value: ComparableValue;
}

export interface CommitRequest {
  quoteId: string;
  /** Opaque key reserved for caller-driven retry safety. MSE does not define the retry protocol. */
  idempotencyKey?: string;
  acceptanceConstraints: AcceptanceConstraint[];
}

export type CommitOutcome = "APPLIED" | "REFUSED" | "INDETERMINATE";

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

export interface CommitResult {
  quoteId: string;
  outcome: CommitOutcome;
  /** Required when outcome is REFUSED. */
  refusalReason?: RefusalReason;
  /** Present when outcome is APPLIED. */
  committedEffects?: Effect[];
}

export type EffectFinalityState = "FINAL" | "PENDING" | "FAILED" | "UNKNOWN";

export interface EffectReceipt {
  effectType: string;
  finality: EffectFinalityState;
  /** Domain-defined realized value, when known. */
  value?: unknown;
  /** ISO 8601 timestamp; present once finality is FINAL or FAILED. */
  settledAt?: string;
}

export interface Receipt {
  quoteId: string;
  mutationOutcome: CommitOutcome;
  /**
   * MUST contain exactly one entry per effect in the corresponding
   * CommitResult.committedEffects — an effect must not silently disappear.
   * An untrackable effect MUST still appear, with finality UNKNOWN, rather
   * than being omitted. See /spec/normative-spec.md §7.
   */
  effectReceipts: EffectReceipt[];
}
