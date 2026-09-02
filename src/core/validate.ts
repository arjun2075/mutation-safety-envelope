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

/** Returns true iff `value operator bound` holds, per AcceptanceConstraint.operator. */
export function compare(
  value: string | number | boolean,
  operator: AcceptanceConstraint["operator"],
  bound: string | number | boolean
): boolean {
  switch (operator) {
    case "<=":
      return value <= bound;
    case ">=":
      return value >= bound;
    case "==":
      return value === bound;
    case "!=":
      return value !== bound;
  }
}

/**
 * Evaluates a set of acceptance constraints against a quote's effects.
 *
 * Per spec: a constraint whose effectType has no matching effect in the
 * quote is UNSATISFIABLE and MUST be treated as a violation (fail closed),
 * not silently ignored. A constraint against an effect whose guarantee.mode
 * is UNKNOWN MUST also be treated as a violation, because the value cannot
 * be relied upon at acceptance time.
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

    if (typeof effect.value !== typeof constraint.value) {
      // Core only defines comparison over primitives of matching type.
      violated.push(constraint);
      continue;
    }

    const ok = compare(
      effect.value as string | number | boolean,
      constraint.operator,
      constraint.value
    );

    if (!ok) violated.push(constraint);
  }

  return violated;
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
