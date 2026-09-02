/**
 * Mutation Safety Envelope (MSE) — core validation helpers, v0.1.0.
 *
 * These functions implement the parts of the normative spec that are
 * mechanically checkable without a real provider: constraint evaluation,
 * quote-expiry checks, and guarantee-consistency checks between a quote
 * and a commit result. They are reference behavior, not the only legal
 * implementation — see /spec/normative-spec.md for the prose rules these
 * functions encode.
 */

import type {
  AcceptanceConstraint,
  ComparableValue,
  CommitResult,
  Effect,
  MutationQuote,
} from "./types";

export class MseViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MseViolation";
  }
}

/**
 * Parses a decimal amount string (as carried by ComparableValue's `money`
 * variant) into a BigInt of "minor units" scaled to a common number of
 * decimal places, without ever passing through a native binary float.
 * This is what makes money comparison decimal-safe: 0.1 + 0.2 problems
 * cannot occur because no IEEE-754 arithmetic is performed at all.
 */
function parseDecimalToScaledBigInt(amount: string, scale: number): bigint {
  const negative = amount.startsWith("-");
  const unsigned = negative ? amount.slice(1) : amount;
  const [wholePart, fractionPart = ""] = unsigned.split(".");
  const paddedFraction = fractionPart.padEnd(scale, "0");
  const digits = `${wholePart}${paddedFraction}`;
  const value = BigInt(digits === "" ? "0" : digits);
  return negative ? -value : value;
}

/**
 * Compares two decimal amount strings exactly (no floating point).
 * Returns -1, 0, or 1 like Array.prototype.sort's comparator convention.
 */
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 {
  const aFraction = a.replace("-", "").split(".")[1] ?? "";
  const bFraction = b.replace("-", "").split(".")[1] ?? "";
  const scale = Math.max(aFraction.length, bFraction.length);

  const aScaled = parseDecimalToScaledBigInt(a, scale);
  const bScaled = parseDecimalToScaledBigInt(b, scale);

  if (aScaled < bScaled) return -1;
  if (aScaled > bScaled) return 1;
  return 0;
}

/**
 * Compares two ComparableValue instances per the normative rules in
 * /spec/normative-spec.md §4a:
 *   - both operands MUST be the identical ComparableValue variant (`type`);
 *     a mismatch fails closed (returns null, meaning "cannot be evaluated,
 *     treat as violated").
 *   - `money` operands additionally MUST share an identical `currency`;
 *     a mismatch fails closed the same way.
 *   - `money` comparison uses decimal-safe string comparison, never a
 *     parse into a native float.
 *
 * Returns -1, 0, or 1 (sort-comparator convention) if comparable, or
 * `null` if the two values cannot be compared at all (fail-closed case).
 */
export function compareComparableValues(
  value: ComparableValue,
  bound: ComparableValue
): -1 | 0 | 1 | null {
  if (value.type !== bound.type) return null;

  switch (value.type) {
    case "number": {
      const b = bound as Extract<ComparableValue, { type: "number" }>;
      if (value.value < b.value) return -1;
      if (value.value > b.value) return 1;
      return 0;
    }
    case "money": {
      const b = bound as Extract<ComparableValue, { type: "money" }>;
      if (value.currency !== b.currency) return null; // fail closed on currency mismatch
      return compareDecimalStrings(value.amount, b.amount);
    }
    case "timestamp": {
      const b = bound as Extract<ComparableValue, { type: "timestamp" }>;
      const valueMs = Date.parse(value.value);
      const boundMs = Date.parse(b.value);
      if (Number.isNaN(valueMs) || Number.isNaN(boundMs)) return null;
      if (valueMs < boundMs) return -1;
      if (valueMs > boundMs) return 1;
      return 0;
    }
    case "boolean": {
      const b = bound as Extract<ComparableValue, { type: "boolean" }>;
      if (value.value === b.value) return 0;
      // boolean has no natural ordering beyond equality; treat false < true
      // only so <=/>= are total, matching common language semantics.
      return value.value ? 1 : -1;
    }
    case "string": {
      const b = bound as Extract<ComparableValue, { type: "string" }>;
      if (value.value < b.value) return -1;
      if (value.value > b.value) return 1;
      return 0;
    }
  }
}

/**
 * Returns true iff `value operator bound` holds, given a pre-computed
 * three-way comparison result (or null for "not comparable").
 */
function applyOperator(
  comparison: -1 | 0 | 1 | null,
  operator: AcceptanceConstraint["operator"]
): boolean {
  if (comparison === null) return false; // fail closed
  switch (operator) {
    case "<=":
      return comparison <= 0;
    case ">=":
      return comparison >= 0;
    case "==":
      return comparison === 0;
    case "!=":
      return comparison !== 0;
  }
}

/**
 * Evaluates a set of acceptance constraints against a quote's effects.
 *
 * Per spec: a constraint whose effectType has no matching effect in the
 * quote is UNSATISFIABLE and MUST be treated as a violation (fail closed),
 * not silently ignored. A constraint against an effect whose guarantee.mode
 * is UNKNOWN MUST also be treated as a violation, because the value cannot
 * be relied upon at acceptance time. A constraint whose bound is not the
 * same ComparableValue variant as the effect's value (or, for money, not
 * the same currency) also fails closed — see compareComparableValues.
 *
 * Returns the list of constraints that were violated. Empty = all satisfied.
 */
export function evaluateAcceptanceConstraints(
  quote: MutationQuote,
  constraints: AcceptanceConstraint[]
): AcceptanceConstraint[] {
  const violated: AcceptanceConstraint[] = [];

  for (const constraint of constraints) {
    const effect = quote.effects.find((e) => e.type === constraint.effectType);

    if (!effect) {
      violated.push(constraint);
      continue;
    }

    if (effect.guarantee.mode === "UNKNOWN") {
      violated.push(constraint);
      continue;
    }

    if (!isComparableValue(effect.value)) {
      // Effect isn't shaped as a ComparableValue at all; cannot be
      // constrained by the core comparator. Fail closed rather than
      // silently treat the constraint as satisfied.
      violated.push(constraint);
      continue;
    }

    const comparison = compareComparableValues(effect.value, constraint.value);
    const ok = applyOperator(comparison, constraint.operator);

    if (!ok) violated.push(constraint);
  }

  return violated;
}

/** Narrow, structural runtime check that a value matches the ComparableValue shape. */
export function isComparableValue(value: unknown): value is ComparableValue {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "number":
      return typeof v.value === "number";
    case "money":
      return typeof v.amount === "string" && typeof v.currency === "string";
    case "timestamp":
      return typeof v.value === "string";
    case "boolean":
      return typeof v.value === "boolean";
    case "string":
      return typeof v.value === "string";
    default:
      return false;
  }
}

/** Returns true iff `quote` has expired as of `now` (defaults to current time). */
export function isQuoteExpired(quote: MutationQuote, now: Date = new Date()): boolean {
  if (!quote.expiresAt) return false;
  return now.getTime() > Date.parse(quote.expiresAt);
}

/**
 * Checks that a CommitResult with outcome=APPLIED did not silently alter
 * any effect whose guarantee.mode was EXACT at quote time.
 *
 * Per spec, an EXACT-guaranteed effect changing value between quote and
 * commit is a conformance violation by the provider, not a legal APPLIED
 * result. This function detects that violation; it does not attempt to
 * "fix" the result.
 *
 * Throws MseViolation if a violation is detected. Returns void otherwise.
 */
export function assertExactGuaranteesHonored(
  quote: MutationQuote,
  result: CommitResult
): void {
  if (result.outcome !== "APPLIED" || !result.committedEffects) return;

  const committedByType = new Map<string, Effect>(
    result.committedEffects.map((e) => [e.type, e])
  );

  for (const quoted of quote.effects) {
    if (quoted.guarantee.mode !== "EXACT") continue;

    const committed = committedByType.get(quoted.type);
    if (!committed) {
      throw new MseViolation(
        `EXACT-guaranteed effect "${quoted.type}" is missing from committedEffects.`
      );
    }

    if (JSON.stringify(committed.value) !== JSON.stringify(quoted.value)) {
      throw new MseViolation(
        `EXACT-guaranteed effect "${quoted.type}" changed value between quote and commit ` +
          `(quoted=${JSON.stringify(quoted.value)}, committed=${JSON.stringify(committed.value)}). ` +
          `This is a provider conformance violation, not a valid APPLIED result.`
      );
    }
  }
}

/**
 * Checks that a Receipt reports finality for every committed effect.
 *
 * Per spec §7, an effect present in CommitResult.committedEffects MUST
 * appear exactly once in Receipt.effectReceipts (with finality UNKNOWN if
 * it is not independently trackable) — it must never silently disappear.
 *
 * Throws MseViolation if a committed effect is missing from the receipt.
 * Returns void otherwise. Does not check for extra/duplicate entries
 * beyond what schema validation already covers.
 */
export function assertReceiptCoversAllCommittedEffects(
  committedEffects: Effect[],
  effectReceipts: { effectType: string }[]
): void {
  const receiptedTypes = new Set(effectReceipts.map((r) => r.effectType));

  for (const effect of committedEffects) {
    if (!receiptedTypes.has(effect.type)) {
      throw new MseViolation(
        `Committed effect "${effect.type}" is missing from the receipt's effectReceipts. ` +
          `An effect must not silently disappear; if it is not independently trackable it ` +
          `must still appear with finality UNKNOWN.`
      );
    }
  }
}
