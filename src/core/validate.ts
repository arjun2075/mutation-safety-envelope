/**
 * Mutation Safety Envelope (MSE) — core validation helpers, v0.2.0.
 *
 * These functions implement the parts of the normative spec that are
 * mechanically checkable without a real provider: quote well-formedness
 * (unit/effect identity), constraint evaluation, quote-expiry checks,
 * guarantee-consistency checks between a quote and a commit result, the
 * per-unit reconciliation contract, and receipt coverage. They are
 * reference behavior, not the only legal implementation — see
 * /spec/normative-spec.md for the prose rules these functions encode.
 *
 * v0.2.0 change: correlation that used to run over Effect.type now runs
 * over Effect.effectId, and every check that used to assume a single
 * mutation-wide outcome now operates per CommittingUnit / UnitResult.
 * See /docs/v0.2-review-response.md.
 */

import type {
  AcceptanceConstraint,
  ComparableValue,
  CommitResult,
  Effect,
  MutationQuote,
  Reconciliation,
  UnitResult,
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

/** Flattens every Effect across every CommittingUnit in a quote, keyed by effectId. */
function allEffectsById(quote: MutationQuote): Map<string, Effect> {
  const byId = new Map<string, Effect>();
  for (const unit of quote.units) {
    for (const effect of unit.effects) {
      byId.set(effect.effectId, effect);
    }
  }
  return byId;
}

/**
 * Evaluates a set of acceptance constraints against a quote's effects.
 * Changed in v0.2.0: constraints and effects are correlated by effectId
 * (not effectType, which is no longer assumed unique across units — see
 * /spec/normative-spec.md §7a).
 *
 * Per spec: a constraint whose effectId has no matching effect anywhere in
 * the quote is UNSATISFIABLE and MUST be treated as a violation (fail
 * closed), not silently ignored. A constraint against an effect whose
 * guarantee.mode is UNKNOWN MUST also be treated as a violation, because
 * the value cannot be relied upon at acceptance time. A constraint whose
 * bound is not the same ComparableValue variant as the effect's value (or,
 * for money, not the same currency) also fails closed — see
 * compareComparableValues.
 *
 * Returns the list of constraints that were violated. Empty = all satisfied.
 */
export function evaluateAcceptanceConstraints(
  quote: MutationQuote,
  constraints: AcceptanceConstraint[]
): AcceptanceConstraint[] {
  const effectsById = allEffectsById(quote);
  const violated: AcceptanceConstraint[] = [];

  for (const constraint of constraints) {
    const effect = effectsById.get(constraint.effectId);

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
 * Validates the well-formedness of a quote's units/effects (spec §1a, §7a):
 *   - every CommittingUnit.unitRef is unique within the quote;
 *   - every Effect.effectId is unique within the quote, across all units.
 *
 * Throws MseViolation on the first violation found (duplicate unitRef or
 * duplicate effectId). Returns void if the quote is well-formed. This is
 * deliberately strict — a provider quote that fails this check is not
 * conformant, not merely suspicious.
 */
export function assertQuoteUnitsWellFormed(quote: MutationQuote): void {
  const seenUnitRefs = new Set<string>();
  const seenEffectIds = new Set<string>();

  for (const unit of quote.units) {
    if (seenUnitRefs.has(unit.unitRef)) {
      throw new MseViolation(
        `Duplicate unitRef "${unit.unitRef}" in quote "${quote.quoteId}". ` +
          `Every CommittingUnit.unitRef MUST be unique within a quote.`
      );
    }
    seenUnitRefs.add(unit.unitRef);

    for (const effect of unit.effects) {
      if (seenEffectIds.has(effect.effectId)) {
        throw new MseViolation(
          `Duplicate effectId "${effect.effectId}" in quote "${quote.quoteId}" ` +
            `(unit "${unit.unitRef}"). Every Effect.effectId MUST be unique within a quote, ` +
            `across all units.`
        );
      }
      seenEffectIds.add(effect.effectId);
    }
  }
}

/**
 * Validates that a CommitResult provides complete coverage of a quote's
 * units (spec §1b): exactly one UnitResult per CommittingUnit, no silent
 * omission, no reference to a unitRef absent from the quote, and no
 * duplicate unitRef within unitResults.
 *
 * Throws MseViolation on the first violation found. Returns void if
 * coverage is complete and unambiguous.
 */
export function assertCommitResultCoversAllUnits(
  quote: MutationQuote,
  result: CommitResult
): void {
  const quoteUnitRefs = new Set(quote.units.map((u) => u.unitRef));
  const seenInResult = new Set<string>();

  for (const unitResult of result.unitResults) {
    if (!quoteUnitRefs.has(unitResult.unitRef)) {
      throw new MseViolation(
        `CommitResult for quote "${quote.quoteId}" contains a UnitResult for unitRef ` +
          `"${unitResult.unitRef}", which is not present in that quote's units.`
      );
    }
    if (seenInResult.has(unitResult.unitRef)) {
      throw new MseViolation(
        `CommitResult for quote "${quote.quoteId}" contains a duplicate UnitResult for ` +
          `unitRef "${unitResult.unitRef}".`
      );
    }
    seenInResult.add(unitResult.unitRef);
  }

  for (const unitRef of quoteUnitRefs) {
    if (!seenInResult.has(unitRef)) {
      throw new MseViolation(
        `CommitResult for quote "${quote.quoteId}" is missing a UnitResult for unitRef ` +
          `"${unitRef}". A unit MUST NOT be silently omitted — see /spec/normative-spec.md §1b.`
      );
    }
  }
}

/**
 * Derives the ONE correct AggregateHint value for a set of unitResults,
 * per the deterministic rule in /spec/normative-spec.md §1c and the
 * AggregateHint schema description: ALL_APPLIED iff every unitResults[].outcome
 * is APPLIED, ALL_REFUSED iff every one is REFUSED, ALL_INDETERMINATE iff
 * every one is INDETERMINATE, MIXED otherwise (including the vacuous case
 * of an empty unitResults array, which cannot occur in a schema-valid
 * CommitResult since unitResults has minItems: 1, but is handled here as
 * MIXED rather than throwing, since this is a pure derivation helper, not
 * a validator).
 *
 * This is the single source of truth for what aggregateHint MUST be for a
 * given unitResults — both a provider wanting to emit a correct hint and
 * assertAggregateHintConsistent (which checks a hint that was actually
 * provided) are expected to use this function rather than reimplement the
 * derivation rule.
 */
export function computeAggregateHint(unitResults: UnitResult[]): "ALL_APPLIED" | "ALL_REFUSED" | "ALL_INDETERMINATE" | "MIXED" {
  if (unitResults.length === 0) return "MIXED";
  if (unitResults.every((ur) => ur.outcome === "APPLIED")) return "ALL_APPLIED";
  if (unitResults.every((ur) => ur.outcome === "REFUSED")) return "ALL_REFUSED";
  if (unitResults.every((ur) => ur.outcome === "INDETERMINATE")) return "ALL_INDETERMINATE";
  return "MIXED";
}

/**
 * Validates that, IF a CommitResult carries an aggregateHint, it agrees
 * with the one value computeAggregateHint derives from its own
 * unitResults (spec §1c). aggregateHint is optional and non-authoritative
 * — this function does not require it to be present, only that a present
 * value not contradict unitResults, since a contradictory hint would be
 * strictly worse than no hint at all (a caller that (wrongly) trusted it
 * as a shortcut would be actively misled, not merely under-informed).
 *
 * Throws MseViolation if aggregateHint is present and disagrees with the
 * derivation. Returns void if aggregateHint is absent, or present and
 * correct.
 */
export function assertAggregateHintConsistent(result: CommitResult): void {
  if (result.aggregateHint === undefined) return;

  const derived = computeAggregateHint(result.unitResults);
  if (result.aggregateHint !== derived) {
    throw new MseViolation(
      `CommitResult for quote "${result.quoteId}" carries aggregateHint ` +
        `"${result.aggregateHint}", but its unitResults actually derive to "${derived}". ` +
        `aggregateHint MUST NOT disagree with unitResults — see /spec/normative-spec.md §1c.`
    );
  }
}

/**
 * Validates the reconciliation contract on an INDETERMINATE UnitResult
 * (spec §4b): `reconciliation` MUST be present with mode set, correlationId
 * MUST be present when mode is MACHINE_RESOLVABLE or AUTHORITATIVE_READ and
 * MUST be absent when mode is NONE. Also validates the inverse: a
 * non-INDETERMINATE UnitResult MUST NOT carry a reconciliation, and MUST
 * NOT carry committedEffects if it is INDETERMINATE (a provider must not
 * claim effects it doesn't know occurred).
 *
 * Throws MseViolation on the first violation found. Returns void otherwise.
 */
export function assertReconciliationContractHonored(unitResult: UnitResult): void {
  if (unitResult.outcome === "INDETERMINATE") {
    if (!unitResult.reconciliation) {
      throw new MseViolation(
        `UnitResult for unitRef "${unitResult.unitRef}" is INDETERMINATE but carries no ` +
          `reconciliation. An INDETERMINATE UnitResult MUST expose a reconciliation contract ` +
          `— see /spec/normative-spec.md §4b.`
      );
    }
    assertReconciliationWellFormed(unitResult.reconciliation, unitResult.unitRef);

    if (unitResult.committedEffects) {
      throw new MseViolation(
        `UnitResult for unitRef "${unitResult.unitRef}" is INDETERMINATE but carries ` +
          `committedEffects. A provider MUST NOT claim effects it does not know occurred.`
      );
    }
  } else if (unitResult.reconciliation) {
    throw new MseViolation(
      `UnitResult for unitRef "${unitResult.unitRef}" has outcome ${unitResult.outcome} but ` +
        `carries a reconciliation, which is only meaningful for INDETERMINATE.`
    );
  }

  if (unitResult.outcome === "REFUSED" && unitResult.committedEffects) {
    throw new MseViolation(
      `UnitResult for unitRef "${unitResult.unitRef}" is REFUSED but carries committedEffects.`
    );
  }
}

/** Structural check of a Reconciliation object per spec §4b's mode/correlationId rules. */
function assertReconciliationWellFormed(reconciliation: Reconciliation, unitRef: string): void {
  if (reconciliation.mode === "NONE") {
    if (reconciliation.correlationId) {
      throw new MseViolation(
        `Reconciliation for unitRef "${unitRef}" has mode NONE but carries a correlationId; ` +
          `there is nothing to correlate a nonexistent path against.`
      );
    }
    return;
  }

  // MACHINE_RESOLVABLE or AUTHORITATIVE_READ
  if (!reconciliation.correlationId) {
    throw new MseViolation(
      `Reconciliation for unitRef "${unitRef}" has mode ${reconciliation.mode} but no ` +
        `correlationId. A caller cannot correlate a future reconciliation/read attempt back ` +
        `to this indeterminate attempt without one — see /spec/normative-spec.md §4b.`
    );
  }
}

/**
 * Validates committed-effect OWNERSHIP across an entire CommitResult (spec
 * §7b): every committed effectId must belong to the same unitRef that
 * claims to have committed it, per the quote's own unit/effect structure.
 *
 * This is a separate normative invariant from EXACT-guarantee honoring
 * (assertExactGuaranteesHonored) — a provider could satisfy "this effect's
 * value didn't drift" while still misattributing which unit produced it
 * (e.g. copy-pasting an effect quoted under unit A into unit B's
 * committedEffects), and EXACT-guarantee checking alone would not catch
 * that, because it only looks up an effectId within the unit already
 * assumed to own it. This function checks the ownership assumption itself,
 * against the quote, across every unit in the CommitResult at once — so it
 * can also catch a committed effectId claimed by two different units in
 * the same CommitResult, not just by one wrong unit.
 *
 * For every effectId appearing in any UnitResult.committedEffects:
 *   - it MUST exist in the quote (in some CommittingUnit.effects);
 *   - it MUST exist specifically in the CommittingUnit whose unitRef
 *     matches the UnitResult.unitRef that claims to have committed it —
 *     an effect quoted under a different unit MUST NOT be accepted;
 *   - it MUST NOT be claimed as committed by more than one UnitResult in
 *     the same CommitResult.
 *
 * Throws MseViolation on the first violation found. Returns void if every
 * committed effect is honestly attributed to the unit that quoted it.
 */
export function assertCommittedEffectsBelongToUnits(
  quote: MutationQuote,
  result: CommitResult
): void {
  // effectId -> the unitRef that quoted it, per the quote itself.
  const quotedUnitByEffectId = new Map<string, string>();
  for (const unit of quote.units) {
    for (const effect of unit.effects) {
      quotedUnitByEffectId.set(effect.effectId, unit.unitRef);
    }
  }

  const claimedByAnyUnit = new Set<string>();

  for (const unitResult of result.unitResults) {
    for (const effect of unitResult.committedEffects ?? []) {
      const quotedUnitRef = quotedUnitByEffectId.get(effect.effectId);

      if (quotedUnitRef === undefined) {
        throw new MseViolation(
          `CommitResult for quote "${quote.quoteId}" claims committed effect ` +
            `"${effect.effectId}" under unit "${unitResult.unitRef}", but no such effectId ` +
            `was ever quoted in this quote. An unknown effectId MUST NOT be accepted as committed.`
        );
      }

      if (quotedUnitRef !== unitResult.unitRef) {
        throw new MseViolation(
          `CommitResult for quote "${quote.quoteId}" claims committed effect ` +
            `"${effect.effectId}" under unit "${unitResult.unitRef}", but that effect was ` +
            `quoted under unit "${quotedUnitRef}". An effect quoted under one unit MUST NOT ` +
            `be accepted as committed by a different unit — see /spec/normative-spec.md §7b.`
        );
      }

      if (claimedByAnyUnit.has(effect.effectId)) {
        throw new MseViolation(
          `CommitResult for quote "${quote.quoteId}" claims committed effect ` +
            `"${effect.effectId}" more than once across unitResults. A committed effectId ` +
            `MUST appear in exactly one UnitResult's committedEffects.`
        );
      }
      claimedByAnyUnit.add(effect.effectId);
    }
  }
}

/**
 * Checks that a UnitResult with outcome=APPLIED did not silently alter any
 * effect whose guarantee.mode was EXACT at quote time, for the specific
 * CommittingUnit this result corresponds to.
 *
 * Per spec, an EXACT-guaranteed effect changing value between quote and
 * commit is a conformance violation by the provider, not a legal APPLIED
 * result. This function detects that violation; it does not attempt to
 * "fix" the result.
 *
 * This function does NOT check committed-effect ownership (whether the
 * committed effectId actually belongs to this unit per the quote) — that
 * is a separate invariant, checked by assertCommittedEffectsBelongToUnits.
 * Relying on this function to incidentally catch a misattributed effect
 * would be fragile: an effect copy-pasted from another unit could still
 * carry a matching EXACT value and pass here while being owned by the
 * wrong unit.
 *
 * Throws MseViolation if a violation is detected. Returns void otherwise.
 */
export function assertExactGuaranteesHonored(
  quote: MutationQuote,
  unitResult: UnitResult
): void {
  if (unitResult.outcome !== "APPLIED" || !unitResult.committedEffects) return;

  const unit = quote.units.find((u) => u.unitRef === unitResult.unitRef);
  if (!unit) {
    throw new MseViolation(
      `UnitResult references unitRef "${unitResult.unitRef}", which is not present in quote ` +
        `"${quote.quoteId}".`
    );
  }

  const committedById = new Map<string, Effect>(
    unitResult.committedEffects.map((e) => [e.effectId, e])
  );

  for (const quoted of unit.effects) {
    if (quoted.guarantee.mode !== "EXACT") continue;

    const committed = committedById.get(quoted.effectId);
    if (!committed) {
      throw new MseViolation(
        `EXACT-guaranteed effect "${quoted.effectId}" (unit "${unit.unitRef}") is missing ` +
          `from committedEffects.`
      );
    }

    if (JSON.stringify(committed.value) !== JSON.stringify(quoted.value)) {
      throw new MseViolation(
        `EXACT-guaranteed effect "${quoted.effectId}" (unit "${unit.unitRef}") changed value ` +
          `between quote and commit (quoted=${JSON.stringify(quoted.value)}, ` +
          `committed=${JSON.stringify(committed.value)}). This is a provider conformance ` +
          `violation, not a valid APPLIED result.`
      );
    }
  }
}

/**
 * Checks that a Receipt correctly and completely correlates every
 * committed effect across every UnitResult in a CommitResult (spec §7b).
 *
 * This validates the FULL correlation chain quote unit -> committed unit
 * result -> committed effect -> effect receipt, not merely that an
 * effectId appears somewhere in the receipt. Concretely, for every
 * EffectReceipt:
 *   - its effectId MUST correspond to an effect actually committed by
 *     some UnitResult in this CommitResult (an unknown or never-committed
 *     effectId MUST fail);
 *   - its unitRef MUST equal the unitRef of the UnitResult that actually
 *     committed that effect — a receipt naming the right effectId under
 *     the wrong unitRef is non-conforming, even though the effectId alone
 *     is globally valid;
 *   - it MUST NOT duplicate another receipt entry for the same effectId.
 *
 * After the receipts themselves are validated, coverage is checked the
 * other direction: every committed effect (across every UnitResult) MUST
 * have exactly one corresponding receipt entry — an effect MUST NOT
 * silently disappear from the receipt, and an untrackable effect MUST
 * still appear (with finality UNKNOWN, checked elsewhere) rather than
 * being omitted.
 *
 * Throws MseViolation on the first violation found, covering all of:
 * effectId+unitRef mismatch, unknown/uncommitted effectId, duplicate
 * receipt for one effectId, and a committed effect missing from the
 * receipt entirely. Returns void if the receipt is a complete and
 * correctly-attributed mirror of what was actually committed.
 */
export function assertReceiptCoversAllCommittedEffects(
  unitResults: UnitResult[],
  effectReceipts: { effectId: string; unitRef: string }[]
): void {
  // effectId -> the unitRef that actually committed it, per unitResults.
  const committedUnitByEffectId = new Map<string, string>();
  for (const unitResult of unitResults) {
    for (const effect of unitResult.committedEffects ?? []) {
      committedUnitByEffectId.set(effect.effectId, unitResult.unitRef);
    }
  }

  const seenReceiptEffectIds = new Set<string>();

  for (const receipt of effectReceipts) {
    if (seenReceiptEffectIds.has(receipt.effectId)) {
      throw new MseViolation(
        `Receipt contains more than one EffectReceipt for effectId "${receipt.effectId}". ` +
          `Duplicate receipts for one committed effect are non-conforming.`
      );
    }
    seenReceiptEffectIds.add(receipt.effectId);

    const committedUnitRef = committedUnitByEffectId.get(receipt.effectId);

    if (committedUnitRef === undefined) {
      throw new MseViolation(
        `Receipt contains an EffectReceipt for effectId "${receipt.effectId}", which was not ` +
          `committed by any UnitResult. A receipt MUST NOT invent effects that were not ` +
          `committed.`
      );
    }

    if (receipt.unitRef !== committedUnitRef) {
      throw new MseViolation(
        `Receipt's EffectReceipt for effectId "${receipt.effectId}" names unitRef ` +
          `"${receipt.unitRef}", but that effect was actually committed under unit ` +
          `"${committedUnitRef}". effectId and unitRef MUST both agree with the commit chain ` +
          `— a receipt referencing the correct effect under the wrong unit is non-conforming, ` +
          `even though the effectId alone exists. See /spec/normative-spec.md §7b.`
      );
    }
  }

  for (const unitResult of unitResults) {
    for (const effect of unitResult.committedEffects ?? []) {
      if (!seenReceiptEffectIds.has(effect.effectId)) {
        throw new MseViolation(
          `Committed effect "${effect.effectId}" (unit "${unitResult.unitRef}") is missing ` +
            `from the receipt's effectReceipts. An effect must not silently disappear; if it ` +
            `is not independently trackable it must still appear with finality UNKNOWN.`
        );
      }
    }
  }
}
