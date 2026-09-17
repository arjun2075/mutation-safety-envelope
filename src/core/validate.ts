/**
 * Mutation Safety Envelope (MSE) — core validation helpers, v0.4.0-dev.0.
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
  AdmissionReport,
  AdmissionRefusal,
  AdmissionCoverage,
  AdmissionFailure,
  ComparableValue,
  CommitResponse,
  CommitResult,
  Effect,
  MutationQuote,
  Reconciliation,
  MutationProposal,
  SatisfactionRealization,
  SatisfactionRealizationEntry,
  SatisfactionRealizationReport,
  UnitLocator,
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
  const seenUnitLocators = new Set<string>();

  for (const unit of quote.units) {
    if (seenUnitRefs.has(unit.unitRef)) {
      throw new MseViolation(
        `Duplicate unitRef "${unit.unitRef}" in quote "${quote.quoteId}". ` +
          `Every CommittingUnit.unitRef MUST be unique within a quote.`
      );
    }
    seenUnitRefs.add(unit.unitRef);

    assertUnitLocatorWellFormed(unit.unitLocator, `unit "${unit.unitRef}"`);
    const scopedKey = unitLocatorKey(unit.unitLocator);
    if (seenUnitLocators.has(scopedKey)) {
      throw new MseViolation(
        `Duplicate unitLocator ${JSON.stringify(unit.unitLocator)} in quote "${quote.quoteId}". ` +
          `A binding-scoped unit MUST appear at most once in a quoted transition set.`
      );
    }
    seenUnitLocators.add(scopedKey);

    if (!Object.prototype.hasOwnProperty.call(unit, "transition")) {
      throw new MseViolation(
        `CommittingUnit "${unit.unitRef}" in quote "${quote.quoteId}" has no transition. ` +
          `Every v0.3.0 quoted unit MUST preserve the opaque transition it would dispatch.`
      );
    }

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

  if (!Array.isArray(quote.admissionRelations)) {
    throw new MseViolation(
      `Quote "${quote.quoteId}" has no admissionRelations array. v0.3.0 quotes MUST carry ` +
        `the array even when no relations are declared.`
    );
  }

  const seenRelationIds = new Set<string>();
  for (const relation of quote.admissionRelations) {
    if (!relation.relationId) {
      throw new MseViolation(`Quote "${quote.quoteId}" contains an admission relation with no relationId.`);
    }
    if (seenRelationIds.has(relation.relationId)) {
      throw new MseViolation(
        `Duplicate admission relationId "${relation.relationId}" in quote "${quote.quoteId}".`
      );
    }
    seenRelationIds.add(relation.relationId);

    if (relation.type !== "REQUIRES_COINCLUSION") {
      throw new MseViolation(
        `Admission relation "${relation.relationId}" has unsupported type "${relation.type}".`
      );
    }
    if (!relation.scopeRef) {
      throw new MseViolation(`Admission relation "${relation.relationId}" has no scopeRef.`);
    }
    if (relation.passEvidence !== undefined && relation.passEvidence !== "REQUIRED") {
      throw new MseViolation(
        `Admission relation "${relation.relationId}" has an unknown passEvidence policy.`
      );
    }
    if (!Array.isArray(relation.triggerUnitRefs) || relation.triggerUnitRefs.length === 0) {
      throw new MseViolation(
        `Admission relation "${relation.relationId}" MUST name at least one triggerUnitRef.`
      );
    }

    const seenTriggers = new Set<string>();
    for (const triggerUnitRef of relation.triggerUnitRefs) {
      if (seenTriggers.has(triggerUnitRef)) {
        throw new MseViolation(
          `Admission relation "${relation.relationId}" repeats triggerUnitRef "${triggerUnitRef}".`
        );
      }
      seenTriggers.add(triggerUnitRef);
      const trigger = quote.units.find((unit) => unit.unitRef === triggerUnitRef);
      if (!trigger) {
        throw new MseViolation(
          `Admission relation "${relation.relationId}" references unknown triggerUnitRef ` +
            `"${triggerUnitRef}" in quote "${quote.quoteId}".`
        );
      }
      if (trigger.unitLocator.scopeRef !== relation.scopeRef) {
        throw new MseViolation(
          `Admission relation "${relation.relationId}" has scopeRef "${relation.scopeRef}", ` +
            `but trigger unit "${triggerUnitRef}" belongs to scope ` +
            `"${trigger.unitLocator.scopeRef}".`
        );
      }
    }
  }
}

function unitLocatorKey(locator: UnitLocator): string {
  return `${locator.scopeRef.length}:${locator.scopeRef}${locator.unitKey.length}:${locator.unitKey}`;
}

function assertUnitLocatorWellFormed(locator: UnitLocator, context: string): void {
  if (
    typeof locator !== "object" ||
    locator === null ||
    typeof locator.scopeRef !== "string" ||
    locator.scopeRef.length === 0 ||
    typeof locator.unitKey !== "string" ||
    locator.unitKey.length === 0
  ) {
    throw new MseViolation(`${context} has a malformed unitLocator.`);
  }
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

/** Checks coverage shape/correlation, not the truth of opaque binding evaluations. */
export function assertAdmissionCoverageWellFormed(
  quote: MutationQuote,
  failures: AdmissionFailure[],
  coverage: AdmissionCoverage[],
  /**
   * The evaluation instant of the report this coverage belongs to. When
   * supplied, every PRIOR_FINAL_TRANSITION record is additionally required to
   * satisfy `finalizedAt <= evaluatedAt`: evidence cannot have become final
   * after the pass that cited it. Optional so a caller validating bare
   * coverage without a report keeps the existing behavior.
   */
  evaluatedAt?: string
): void {
  if (!Array.isArray(coverage)) throw new MseViolation("Admission coverage is required.");
  if (!Array.isArray(failures)) throw new MseViolation("Admission failures must be an array.");
  const declared = new Set(quote.admissionRelations.map(r => r.relationId));
  const failureIds = failures.map(failure => {
    if (!failure || typeof failure.relationId !== "string" || failure.relationId.length === 0) {
      throw new MseViolation("Admission failure has a malformed relation reference.");
    }
    return failure.relationId;
  });
  const failed = new Set(failureIds);
  if (failed.size !== failures.length || [...failed].some(id => !declared.has(id))) {
    throw new MseViolation("Duplicate or undeclared failure relation reference.");
  }
  const byId = new Map<string, AdmissionCoverage>();
  for (const entry of coverage) {
    if (!entry || !declared.has(entry.relationId) || byId.has(entry.relationId)) {
      throw new MseViolation("Duplicate or undeclared coverage relation reference.");
    }
    if (!["PASSED", "FAILED", "DEFERRED"].includes(entry.status)) {
      throw new MseViolation("Unknown coverage status; early stop is not exhaustive evaluation.");
    }
    const keys = entry.status === "DEFERRED"
      ? ["relationId", "status", "dependsOn"]
      : entry.status === "PASSED"
        ? ["relationId", "status", "satisfactions", "requiredParticipants"]
        : ["relationId", "status"];
    if (Object.keys(entry).some(key => !keys.includes(key))) throw new MseViolation("Field in wrong coverage branch.");
    if ((entry.status === "FAILED") !== failed.has(entry.relationId)) {
      throw new MseViolation("Coverage status contradicts failures.");
    }
    if (entry.status === "DEFERRED") {
      if (!Array.isArray(entry.dependsOn) || !entry.dependsOn.length ||
          new Set(entry.dependsOn).size !== entry.dependsOn.length ||
          entry.dependsOn.some(id => !declared.has(id) || id === entry.relationId)) {
        throw new MseViolation("Deferred coverage requires unique declared dependencies, excluding itself.");
      }
    }
    if (entry.status === "PASSED") {
      const relation = quote.admissionRelations.find(r => r.relationId === entry.relationId)!;
      if (relation.passEvidence === "REQUIRED" &&
          (!Array.isArray(entry.satisfactions) || entry.satisfactions.length === 0)) {
        throw new MseViolation(
          `PASSED coverage for relation "${entry.relationId}" requires satisfaction evidence.`
        );
      }
      // The complete participant set this evaluation required. Carrying it
      // lets a reader see an omission that satisfaction evidence alone hides
      // (UCP #799): a PASSED citing one of two required participants is
      // otherwise indistinguishable from a complete pass.
      const requiredParticipantKeys = new Set<string>();
      if (entry.requiredParticipants !== undefined) {
        if (!Array.isArray(entry.requiredParticipants) || entry.requiredParticipants.length === 0) {
          throw new MseViolation(
            `PASSED coverage for relation "${entry.relationId}" carries an empty required ` +
              `participant set; omit the field instead of asserting no participants.`
          );
        }
        for (const participant of entry.requiredParticipants) {
          if (!participant || typeof participant !== "object" ||
              Object.keys(participant).some(key => !["unitLocator", "transition"].includes(key)) ||
              !Object.prototype.hasOwnProperty.call(participant, "transition")) {
            throw new MseViolation(
              `Malformed required participant on relation "${entry.relationId}".`
            );
          }
          assertUnitLocatorWellFormed(
            participant.unitLocator,
            `Required participant for relation "${entry.relationId}"`
          );
          if (participant.unitLocator.scopeRef !== relation.scopeRef) {
            throw new MseViolation(
              `Required participant for relation "${entry.relationId}" is outside declared scope ` +
                `"${relation.scopeRef}".`
            );
          }
          const participantKey = unitLocatorKey(participant.unitLocator);
          if (requiredParticipantKeys.has(participantKey)) {
            throw new MseViolation(
              `Relation "${entry.relationId}" repeats required participant ` +
                `${JSON.stringify(participant.unitLocator)}.`
            );
          }
          requiredParticipantKeys.add(participantKey);
        }
      } else if (relation.passEvidence === "REQUIRED") {
        throw new MseViolation(
          `PASSED coverage for relation "${entry.relationId}" declares pass evidence required ` +
            `but does not state the participant set that evidence must cover.`
        );
      }

      // Independent grounding of the stated set.
      //
      // Checking `satisfactions` against a producer-supplied
      // `requiredParticipants` is tautological on its own: a producer that
      // omits a participant from BOTH arrays still validates. Core therefore
      // independently derives what it can and treats it as a LOWER BOUND.
      //
      // For REQUIRES_COINCLUSION, every quoted unit inside the relation's
      // declared scope that is not itself a trigger is a participant core can
      // see without any domain knowledge: the relation says those transitions
      // are admissible only together. Such a unit MUST appear in the stated
      // required set.
      //
      // This is deliberately a lower bound, not equality. The true required
      // set may also contain units absent from the quote — satisfied by prior
      // final history — which core cannot enumerate, because only the binding
      // knows which scoped units exist and which already reached the state
      // the gate wants. Binding trace conformance owns that remainder; see
      // /spec/normative-spec.md §3.2.
      if (requiredParticipantKeys.size > 0) {
        const triggers = new Set(relation.triggerUnitRefs);
        for (const unit of quote.units) {
          if (unit.unitLocator.scopeRef !== relation.scopeRef) continue;
          if (triggers.has(unit.unitRef)) continue;
          if (!requiredParticipantKeys.has(unitLocatorKey(unit.unitLocator))) {
            throw new MseViolation(
              `PASSED coverage for relation "${entry.relationId}" omits quoted unit ` +
                `${JSON.stringify(unit.unitLocator)} from its required participant set, ` +
                `although that unit is co-included in the relation's declared scope; ` +
                `the stated set MUST contain every core-visible required participant.`
            );
          }
        }
      }
      const seenSatisfactionUnits = new Set<string>();
      if (entry.satisfactions !== undefined) {
        if (!Array.isArray(entry.satisfactions) || entry.satisfactions.length === 0) {
          throw new MseViolation("Satisfaction evidence, when present, must be non-empty.");
        }
        for (const satisfaction of entry.satisfactions) {
          if (!satisfaction || typeof satisfaction !== "object" ||
              !Object.prototype.hasOwnProperty.call(satisfaction, "transition")) {
            throw new MseViolation("Admission satisfaction has no transition.");
          }
          let participantKey: string;
          if (satisfaction.source === "CURRENT_REQUEST") {
            const satisfactionKeys = ["source", "unitRef", "transition"];
            if (Object.keys(satisfaction).some(key => !satisfactionKeys.includes(key)) ||
                typeof satisfaction.unitRef !== "string" || satisfaction.unitRef.length === 0) {
              throw new MseViolation("Malformed current-request satisfaction evidence.");
            }
            const unit = quote.units.find(candidate => candidate.unitRef === satisfaction.unitRef);
            if (!unit || unit.unitLocator.scopeRef !== relation.scopeRef) {
              throw new MseViolation("Current-request satisfaction references an unrelated unit.");
            }
            if (JSON.stringify(unit.transition) !== JSON.stringify(satisfaction.transition)) {
              throw new MseViolation("Current-request satisfaction transition contradicts its quoted unit.");
            }
            participantKey = unitLocatorKey(unit.unitLocator);
          } else if (satisfaction.source === "PRIOR_FINAL_TRANSITION") {
            const satisfactionKeys = [
              "source", "unitLocator", "transition", "transitionRef", "finalizedAt",
            ];
            if (Object.keys(satisfaction).some(key => !satisfactionKeys.includes(key))) {
              throw new MseViolation("Field in wrong prior-final satisfaction branch.");
            }
            assertUnitLocatorWellFormed(
              satisfaction.unitLocator,
              `Admission satisfaction for relation "${entry.relationId}"`
            );
            if (satisfaction.unitLocator.scopeRef !== relation.scopeRef) {
              throw new MseViolation("Prior-final satisfaction references an unrelated unit.");
            }
            if (typeof satisfaction.transitionRef !== "string" ||
                satisfaction.transitionRef.length === 0) {
              throw new MseViolation("Prior-final satisfaction requires a transitionRef.");
            }
            if (!isIsoDateTime(satisfaction.finalizedAt)) {
              throw new MseViolation("Prior-final satisfaction finalizedAt MUST be an ISO 8601 timestamp.");
            }
            // Temporal consistency: prior evidence cannot become final after
            // the pass that cited it as already-final history. Equality is
            // permitted; the instants are only compared, never ordered
            // beyond this bound. Both timestamps are already on the wire.
            if (evaluatedAt !== undefined &&
                Date.parse(satisfaction.finalizedAt) > Date.parse(evaluatedAt)) {
              throw new MseViolation(
                `Prior-final satisfaction for relation "${entry.relationId}" claims finalization ` +
                  `at ${satisfaction.finalizedAt}, after the report's evaluatedAt ${evaluatedAt}; ` +
                  `prior-final evidence MUST satisfy finalizedAt <= evaluatedAt.`
              );
            }
            participantKey = unitLocatorKey(satisfaction.unitLocator);
          } else {
            throw new MseViolation("Unknown admission satisfaction source.");
          }
          if (seenSatisfactionUnits.has(participantKey)) {
            throw new MseViolation("Duplicate satisfaction evidence for one participating unit.");
          }
          if (requiredParticipantKeys.size > 0 && !requiredParticipantKeys.has(participantKey)) {
            throw new MseViolation(
              `Satisfaction evidence for relation "${entry.relationId}" cites a participant ` +
                `outside the required participant set this evaluation stated.`
            );
          }
          seenSatisfactionUnits.add(participantKey);
        }
      }
      // Evidence must cover the stated required set EXACTLY. A subset is the
      // omission Weston identified on UCP #799: PASSED citing one of two
      // required participants must not validate.
      if (requiredParticipantKeys.size > 0) {
        const uncovered = [...requiredParticipantKeys].filter(key => !seenSatisfactionUnits.has(key));
        if (uncovered.length > 0) {
          throw new MseViolation(
            `PASSED coverage for relation "${entry.relationId}" cites satisfaction for ` +
              `${seenSatisfactionUnits.size} of ${requiredParticipantKeys.size} required ` +
              `participants; evidence MUST cover the required participant set exactly.`
          );
        }
      }
    }
    byId.set(entry.relationId, entry);
  }
  if (byId.size !== declared.size) throw new MseViolation("Admission coverage omits a declared relation.");
  const checked = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new MseViolation("Deferred dependency cycle.");
    if (checked.has(id)) return;
    const entry = byId.get(id)!;
    if (entry.status === "PASSED") throw new MseViolation("Deferred dependency must lead to a failed relation, not PASSED.");
    visiting.add(id);
    if (entry.status === "DEFERRED") entry.dependsOn.forEach(visit);
    visiting.delete(id);
    checked.add(id);
  };
  coverage.filter(e => e.status === "DEFERRED").forEach(e => visit(e.relationId));
}

/** Validates shared admission metadata and coverage on either response path. */
export function assertAdmissionReportWellFormed(
  quote: MutationQuote,
  proposal: MutationProposal,
  report: AdmissionReport
): void {
  if (report.quoteId !== quote.quoteId) {
    throw new MseViolation(
      `AdmissionReport quoteId "${report.quoteId}" does not match evaluated quote "${quote.quoteId}".`
    );
  }
  if (report.proposalId !== proposal.proposalId) {
    throw new MseViolation(
      `AdmissionReport proposalId "${report.proposalId}" does not match evaluated proposal "${proposal.proposalId}".`
    );
  }
  if (!isIsoDateTime(report.evaluatedAt)) {
    throw new MseViolation(`AdmissionReport evaluatedAt MUST be an ISO 8601 timestamp.`);
  }
  assertAdmissionCoverageWellFormed(quote, report.failures, report.coverage, report.evaluatedAt);
}

/**
 * Validates a pre-dispatch AdmissionRefusal against the quote and proposal it
 * claims to describe. This rejects structurally impossible COMPLETE claims,
 * wrong-scope repair references, duplicate/contradictory requirements,
 * quote-local identity confusion, and failures for relations the quote never
 * declared. Domain-level completeness remains a binding conformance promise;
 * core validation cannot infer it from opaque state or transitions.
 */
export function assertAdmissionRefusalWellFormed(
  quote: MutationQuote,
  proposal: MutationProposal,
  refusal: AdmissionRefusal
): void {
  assertAdmissionReportWellFormed(quote, proposal, refusal);
  if (!Array.isArray(refusal.failures) || refusal.failures.length === 0) {
    throw new MseViolation(`AdmissionRefusal MUST contain at least one failed relation.`);
  }
  const relations = new Map(quote.admissionRelations.map((relation) => [relation.relationId, relation]));
  const quotedLocators = new Set(quote.units.map((unit) => unitLocatorKey(unit.unitLocator)));
  const seenFailures = new Set<string>();

  for (const failure of refusal.failures) {
    const relation = relations.get(failure.relationId);
    if (!relation) {
      throw new MseViolation(
        `Admission failure references relationId "${failure.relationId}", which the evaluated ` +
          `quote did not declare.`
      );
    }
    if (seenFailures.has(failure.relationId)) {
      throw new MseViolation(
        `AdmissionRefusal repeats failure for relationId "${failure.relationId}".`
      );
    }
    seenFailures.add(failure.relationId);

    const witness = failure.witness;
    if (!witness || typeof witness !== "object") {
      throw new MseViolation(
        `Admission failure "${failure.relationId}" has no explicit witness disposition.`
      );
    }

    if (witness.disposition === "UNAVAILABLE" || witness.disposition === "NOT_REPAIRABLE") {
      if (Object.prototype.hasOwnProperty.call(witness, "requiredTransitions")) {
        throw new MseViolation(
          `Admission failure "${failure.relationId}" has disposition ${witness.disposition} ` +
            `but also carries requiredTransitions.`
        );
      }
      continue;
    }

    if (witness.disposition !== "COMPLETE" && witness.disposition !== "PARTIAL") {
      throw new MseViolation(
        `Admission failure "${failure.relationId}" has unknown witness disposition.`
      );
    }
    if (!Array.isArray(witness.requiredTransitions) || witness.requiredTransitions.length === 0) {
      throw new MseViolation(
        `Admission failure "${failure.relationId}" advertises ${witness.disposition} repair ` +
          `without a non-empty requiredTransitions list.`
      );
    }

    const seenRequiredLocators = new Set<string>();
    for (const required of witness.requiredTransitions) {
      assertUnitLocatorWellFormed(
        required.unitLocator,
        `Admission failure "${failure.relationId}" required transition`
      );
      if (!Object.prototype.hasOwnProperty.call(required, "transition")) {
        throw new MseViolation(
          `Admission failure "${failure.relationId}" carries a required unit with no transition.`
        );
      }
      if (required.unitLocator.scopeRef !== relation.scopeRef) {
        throw new MseViolation(
          `Admission failure "${failure.relationId}" references unit scope ` +
            `"${required.unitLocator.scopeRef}", outside declared scope "${relation.scopeRef}".`
        );
      }

      const requiredKey = unitLocatorKey(required.unitLocator);
      if (seenRequiredLocators.has(requiredKey)) {
        throw new MseViolation(
          `Admission failure "${failure.relationId}" repeats unitLocator ` +
            `${JSON.stringify(required.unitLocator)}; duplicate or contradictory transitions ` +
            `for one unit are not an unambiguous witness.`
        );
      }
      seenRequiredLocators.add(requiredKey);

      if (quotedLocators.has(requiredKey)) {
        throw new MseViolation(
          `Admission failure "${failure.relationId}" calls ` +
            `${JSON.stringify(required.unitLocator)} missing even though that unit is already ` +
            `present in the evaluated quote.`
        );
      }
    }
  }
}

/**
 * Derives the execution-time realization of every satisfaction record in a
 * successful admission report, by correlating it with the `unitResults` of
 * the CommitResult in the same response.
 *
 * This is the UCP #799 contradiction Weston identified: at admission a
 * CURRENT_REQUEST satisfier has only been *requested*, which is the same
 * not-yet-final condition the PRIOR_FINAL_TRANSITION branch excludes. A
 * caller acceptance constraint can then refuse exactly that unit, leaving a
 * PASSED record whose evidence the same response reports as REFUSED.
 *
 * The derivation is total and deterministic (spec §3.2a):
 *
 * - CURRENT_REQUEST + APPLIED        -> REALIZED
 * - CURRENT_REQUEST + REFUSED        -> NOT_REALIZED
 * - CURRENT_REQUEST + INDETERMINATE  -> INDETERMINATE
 * - PRIOR_FINAL_TRANSITION           -> REALIZED (already final by §3.2)
 *
 * It does NOT change admission-time truth: `PASSED` still means the required
 * transition was present when admission was evaluated, and is not rewritten.
 * It imposes no ordering and no atomicity: nothing here requires a dependent
 * unit to wait for its satisfier to become APPLIED (spec §1d).
 */
export function deriveSatisfactionRealization(
  report: AdmissionReport,
  result: CommitResult
): SatisfactionRealizationReport {
  const outcomeByUnitRef = new Map(result.unitResults.map(unit => [unit.unitRef, unit.outcome]));
  const entries: SatisfactionRealizationEntry[] = [];

  for (const entry of report.coverage) {
    if (entry.status !== "PASSED" || !entry.satisfactions) continue;
    for (const satisfaction of entry.satisfactions) {
      if (satisfaction.source === "PRIOR_FINAL_TRANSITION") {
        // Realized. A prior-final record is only admissible when the cited
        // transition is already final, so the satisfaction occurred; `source`
        // distinguishes historical from current-request realization. It
        // carries no `outcome` because this response did not execute it.
        entries.push({
          relationId: entry.relationId,
          source: "PRIOR_FINAL_TRANSITION",
          unitLocator: satisfaction.unitLocator,
          realization: "REALIZED",
        });
        continue;
      }
      const outcome = outcomeByUnitRef.get(satisfaction.unitRef);
      if (outcome === undefined) {
        throw new MseViolation(
          `Current-request satisfaction for relation "${entry.relationId}" cites unit ` +
            `"${satisfaction.unitRef}", which has no UnitResult in the correlated CommitResult; ` +
            `execution-time realization cannot be determined.`
        );
      }
      const realization: SatisfactionRealization =
        outcome === "APPLIED" ? "REALIZED" : outcome === "REFUSED" ? "NOT_REALIZED" : "INDETERMINATE";
      entries.push({
        relationId: entry.relationId,
        source: "CURRENT_REQUEST",
        unitRef: satisfaction.unitRef,
        realization,
        outcome,
      });
    }
  }

  return {
    quoteId: report.quoteId,
    entries,
    allRealized: entries.every(entry => entry.realization === "REALIZED"),
  };
}

/**
 * Throws if a supplied realization report disagrees with what
 * `deriveSatisfactionRealization` derives from the same response. Like
 * `assertAggregateHintConsistent`, this exists so a derived summary cannot
 * contradict the authoritative data it was derived from.
 */
export function assertSatisfactionRealizationConsistent(
  report: AdmissionReport,
  result: CommitResult,
  claimed: SatisfactionRealizationReport
): void {
  const derived = deriveSatisfactionRealization(report, result);
  const normalize = (value: SatisfactionRealizationReport) => ({
    quoteId: value.quoteId,
    allRealized: value.allRealized,
    entries: [...value.entries]
      .map(entry => JSON.stringify(entry))
      .sort(),
  });
  if (JSON.stringify(normalize(claimed)) !== JSON.stringify(normalize(derived))) {
    throw new MseViolation(
      "Claimed satisfaction realization disagrees with the derivation from this response's " +
        "coverage and unitResults."
    );
  }
}

/**
 * Validates the admission/commit response split against its quote context.
 *
 * On the COMMIT_RESULT branch this RETURNS the derived satisfaction
 * realization, so the §3.2a correlation is part of the standard validation
 * path rather than an optional utility a consumer might never call. A
 * consumer that validates a response therefore receives the execution-time
 * reading without opting in, and cannot accidentally read admission `PASSED`
 * as realized satisfaction just by skipping a helper.
 *
 * Returns undefined for ADMISSION_REFUSED, where no execution occurred and
 * realization is not a meaningful question.
 */
export function assertCommitResponseWellFormed(
  quote: MutationQuote,
  proposal: MutationProposal,
  response: CommitResponse
): SatisfactionRealizationReport | undefined {
  if (!response || typeof response !== "object") {
    throw new MseViolation("CommitResponse is required.");
  }
  if (response.kind === "ADMISSION_REFUSED") {
    if (!response.admissionRefusal) {
      throw new MseViolation("ADMISSION_REFUSED requires an admissionRefusal.");
    }
    assertAdmissionRefusalWellFormed(quote, proposal, response.admissionRefusal);
    return undefined;
  }
  if (response.kind !== "COMMIT_RESULT") {
    throw new MseViolation("Unknown CommitResponse kind.");
  }
  if (!response.admissionReport) {
    throw new MseViolation("COMMIT_RESULT requires an admissionReport.");
  }
  assertAdmissionReportWellFormed(quote, proposal, response.admissionReport);
  if (response.admissionReport.failures.length > 0) {
    throw new MseViolation("COMMIT_RESULT admissionReport MUST NOT contain failures.");
  }
  if (!response.commitResult || response.commitResult.quoteId !== quote.quoteId) {
    throw new MseViolation("COMMIT_RESULT does not correlate to the evaluated quote.");
  }
  assertCommitResultCoversAllUnits(quote, response.commitResult);
  // With a COMMIT_RESULT available, every CURRENT_REQUEST satisfaction record
  // MUST be correlatable with its unit's execution outcome, so an admitted
  // pass cannot be read as an execution-time realized satisfaction when the
  // same response refuses the satisfier. This rejects a record whose cited
  // unit has no result; it does not refuse the response merely because a
  // satisfier was REFUSED or INDETERMINATE, which remains a legitimate
  // non-atomic outcome (spec §1d/§3.2a).
  //
  // The verdicts are RETURNED rather than discarded, so the consumer
  // obligation in §3.2a is discharged by the standard validation path.
  return deriveSatisfactionRealization(response.admissionReport, response.commitResult);
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
  const candidate = unitResult as {
    unitRef: string;
    outcome: UnitResult["outcome"];
    refusalReason?: string;
    committedEffects?: Effect[];
    reconciliation?: Reconciliation;
  };

  if (
    candidate.outcome === "APPLIED" &&
    !Array.isArray(candidate.committedEffects)
  ) {
    throw new MseViolation(
      `UnitResult for unitRef "${candidate.unitRef}" is APPLIED but carries no ` +
        `committedEffects array. It MUST be present even when empty.`
    );
  }

  if (candidate.outcome === "INDETERMINATE") {
    if (!candidate.reconciliation) {
      throw new MseViolation(
        `UnitResult for unitRef "${candidate.unitRef}" is INDETERMINATE but carries no ` +
          `reconciliation. An INDETERMINATE UnitResult MUST expose a reconciliation contract ` +
          `— see /spec/normative-spec.md §4b.`
      );
    }
    assertReconciliationWellFormed(candidate.reconciliation, candidate.unitRef);

    if (candidate.committedEffects) {
      throw new MseViolation(
        `UnitResult for unitRef "${candidate.unitRef}" is INDETERMINATE but carries ` +
          `committedEffects. A provider MUST NOT claim effects it does not know occurred.`
      );
    }
  } else if (candidate.reconciliation) {
    throw new MseViolation(
      `UnitResult for unitRef "${candidate.unitRef}" has outcome ${candidate.outcome} but ` +
        `carries a reconciliation, which is only meaningful for INDETERMINATE.`
    );
  }

  if (candidate.outcome === "REFUSED" && candidate.committedEffects) {
    throw new MseViolation(
      `UnitResult for unitRef "${candidate.unitRef}" is REFUSED but carries committedEffects.`
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
