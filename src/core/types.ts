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
  /** Domain-defined payload. Opaque to the core. */
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

/** A principal/agent-defined bound checked against the final pre-commit quote. */
export interface AcceptanceConstraint {
  effectType: string;
  operator: ComparisonOperator;
  /** Primitive comparable value only — see spec for why structured values are out of scope. */
  value: string | number | boolean;
}

export interface CommitRequest {
  quoteId: string;
  /** Opaque key reserved for caller-driven retry safety. MSE does not define the retry protocol. */
  idempotencyKey?: string;
  acceptanceConstraints: AcceptanceConstraint[];
}

export type CommitOutcome = "APPLIED" | "REFUSED" | "INDETERMINATE";

export type RefusalReason =
  | "QUOTE_EXPIRED"
  | "SNAPSHOT_MISMATCH"
  | "CONSTRAINT_VIOLATED"
  | "GUARANTEE_UNKNOWN_AT_COMMIT"
  | "PROVIDER_REJECTED";

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
  effectReceipts: EffectReceipt[];
}
