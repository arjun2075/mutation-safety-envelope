import { describe, it, expect } from "vitest";
import {
  evaluateAcceptanceConstraints,
  isQuoteExpired,
  assertExactGuaranteesHonored,
  assertReceiptCoversAllCommittedEffects,
  assertQuoteUnitsWellFormed,
  assertCommitResultCoversAllUnits,
  assertCommittedEffectsBelongToUnits,
  assertReconciliationContractHonored,
  computeAggregateHint,
  assertAggregateHintConsistent,
  compareComparableValues,
  compareDecimalStrings,
  MseViolation,
} from "../src/core/validate";
import { ReferenceProvider } from "../src/core/reference-provider";
import type {
  MutationQuote,
  CommittingUnit,
  AcceptanceConstraint,
  UnitResult,
  ComparableValue,
  EffectReceipt,
  CommitResponse,
  CommitResult,
} from "../src/core/types";

function money(amount: string, currency = "USD"): ComparableValue {
  return { type: "money", amount, currency };
}

function unit(unitRef: string, effects: CommittingUnit["effects"] = []): CommittingUnit {
  return {
    unitRef,
    unitLocator: { scopeRef: "test:scope", unitKey: unitRef },
    transition: { operation: "TEST" },
    effects,
  };
}

function committed(response: CommitResponse): CommitResult {
  expect(response.kind).toBe("COMMIT_RESULT");
  if (response.kind !== "COMMIT_RESULT") {
    throw new Error("Expected COMMIT_RESULT");
  }
  return response.commitResult;
}

function baseQuote(overrides: Partial<MutationQuote> = {}): MutationQuote {
  const { admissionRelations, ...otherOverrides } = overrides;
  return {
    quoteId: "q1",
    target: { orderId: "order_1" },
    units: [
      unit("unit_a", [
        {
          effectId: "eff_a1",
          type: "retail:order_total_delta",
          value: money("42.00"),
          guarantee: { mode: "EXACT" },
        },
      ]),
    ],
    ...otherOverrides,
    admissionRelations: admissionRelations ?? [],
  };
}

describe("compareDecimalStrings — decimal-safe comparison", () => {
  it("compares equal amounts with different trailing zero counts as equal", () => {
    expect(compareDecimalStrings("42.00", "42")).toBe(0);
    expect(compareDecimalStrings("42.50", "42.5")).toBe(0);
  });

  it("compares amounts with different decimal precision correctly", () => {
    expect(compareDecimalStrings("42.1", "42.10")).toBe(0);
    expect(compareDecimalStrings("42.100000001", "42.1")).toBe(1);
    expect(compareDecimalStrings("42.099999999", "42.1")).toBe(-1);
  });

  it("does not fall prey to classic binary-float rounding (0.1 + 0.2 style cases)", () => {
    expect(compareDecimalStrings("0.10", "0.1")).toBe(0);
    expect(compareDecimalStrings("100000000000000000.01", "100000000000000000.02")).toBe(-1);
  });

  it("handles negative amounts", () => {
    expect(compareDecimalStrings("-5.00", "-5")).toBe(0);
    expect(compareDecimalStrings("-5.01", "-5.00")).toBe(-1);
    expect(compareDecimalStrings("-5.00", "5.00")).toBe(-1);
  });
});

describe("compareComparableValues — fail-closed type/currency rules", () => {
  it("compares two number values", () => {
    expect(
      compareComparableValues({ type: "number", value: 5 }, { type: "number", value: 10 })
    ).toBe(-1);
  });

  it("compares two money values in the same currency", () => {
    expect(compareComparableValues(money("100.00"), money("150.00"))).toBe(-1);
    expect(compareComparableValues(money("150.00"), money("150.00"))).toBe(0);
    expect(compareComparableValues(money("200.00"), money("150.00"))).toBe(1);
  });

  it("fails closed (returns null) on currency mismatch", () => {
    expect(compareComparableValues(money("100.00", "USD"), money("100.00", "EUR"))).toBeNull();
  });

  it("fails closed (returns null) on variant/type mismatch", () => {
    expect(compareComparableValues(money("100.00"), { type: "number", value: 100 })).toBeNull();
    expect(
      compareComparableValues({ type: "string", value: "abc" }, { type: "number", value: 1 })
    ).toBeNull();
  });

  it("compares timestamps", () => {
    expect(
      compareComparableValues(
        { type: "timestamp", value: "2026-01-01T00:00:00Z" },
        { type: "timestamp", value: "2026-06-01T00:00:00Z" }
      )
    ).toBe(-1);
  });
});

describe("assertQuoteUnitsWellFormed", () => {
  it("does not throw for a well-formed multi-unit quote with unique unitRefs and effectIds", () => {
    const quote = baseQuote({
      units: [
        unit("unit_a", [
          { effectId: "eff_a1", type: "retail:order_total_delta", value: money("10.00"), guarantee: { mode: "EXACT" } },
        ]),
        unit("unit_b", [
          { effectId: "eff_b1", type: "retail:order_total_delta", value: money("20.00"), guarantee: { mode: "EXACT" } },
        ]),
      ],
    });
    expect(() => assertQuoteUnitsWellFormed(quote)).not.toThrow();
  });

  it("throws MseViolation on duplicate unitRef", () => {
    const quote = baseQuote({
      units: [unit("unit_a", []), unit("unit_a", [])],
    });
    expect(() => assertQuoteUnitsWellFormed(quote)).toThrow(MseViolation);
  });

  it("throws MseViolation on duplicate effectId across different units", () => {
    const quote = baseQuote({
      units: [
        unit("unit_a", [
          { effectId: "eff_shared", type: "retail:order_total_delta", value: money("10.00"), guarantee: { mode: "EXACT" } },
        ]),
        unit("unit_b", [
          { effectId: "eff_shared", type: "retail:order_total_delta", value: money("20.00"), guarantee: { mode: "EXACT" } },
        ]),
      ],
    });
    expect(() => assertQuoteUnitsWellFormed(quote)).toThrow(MseViolation);
  });
});

describe("assertCommitResultCoversAllUnits — complete coverage (spec §1b)", () => {
  const quote = baseQuote({
    units: [unit("unit_a"), unit("unit_b")],
  });

  it("does not throw when every unit has exactly one result", () => {
    const result = {
      quoteId: quote.quoteId,
      unitResults: [
        { unitRef: "unit_a", outcome: "APPLIED" as const, committedEffects: [] },
        { unitRef: "unit_b", outcome: "REFUSED" as const, refusalReason: "PROVIDER_REJECTED" as const },
      ],
    };
    expect(() => assertCommitResultCoversAllUnits(quote, result)).not.toThrow();
  });

  it("throws MseViolation when a unit is missing from unitResults", () => {
    const result = {
      quoteId: quote.quoteId,
      unitResults: [{ unitRef: "unit_a", outcome: "APPLIED" as const, committedEffects: [] }],
    };
    expect(() => assertCommitResultCoversAllUnits(quote, result)).toThrow(MseViolation);
  });

  it("throws MseViolation on a duplicate unitRef within unitResults", () => {
    const result = {
      quoteId: quote.quoteId,
      unitResults: [
        { unitRef: "unit_a", outcome: "APPLIED" as const, committedEffects: [] },
        { unitRef: "unit_a", outcome: "REFUSED" as const, refusalReason: "PROVIDER_REJECTED" as const },
        { unitRef: "unit_b", outcome: "APPLIED" as const, committedEffects: [] },
      ],
    };
    expect(() => assertCommitResultCoversAllUnits(quote, result)).toThrow(MseViolation);
  });

  it("throws MseViolation when a unitResult references a unitRef absent from the quote", () => {
    const result = {
      quoteId: quote.quoteId,
      unitResults: [
        { unitRef: "unit_a", outcome: "APPLIED" as const, committedEffects: [] },
        { unitRef: "unit_b", outcome: "APPLIED" as const, committedEffects: [] },
        { unitRef: "unit_nonexistent", outcome: "APPLIED" as const, committedEffects: [] },
      ],
    };
    expect(() => assertCommitResultCoversAllUnits(quote, result)).toThrow(MseViolation);
  });
});

describe("assertReconciliationContractHonored — spec §4b", () => {
  it("does not throw for an INDETERMINATE unit with a well-formed MACHINE_RESOLVABLE reconciliation", () => {
    const ur: UnitResult = {
      unitRef: "unit_a",
      outcome: "INDETERMINATE",
      reconciliation: { mode: "MACHINE_RESOLVABLE", correlationId: "corr_1" },
    };
    expect(() => assertReconciliationContractHonored(ur)).not.toThrow();
  });

  it("does not throw for an INDETERMINATE unit with mode NONE and no correlationId", () => {
    const ur: UnitResult = {
      unitRef: "unit_a",
      outcome: "INDETERMINATE",
      reconciliation: { mode: "NONE" },
    };
    expect(() => assertReconciliationContractHonored(ur)).not.toThrow();
  });

  it("throws MseViolation when INDETERMINATE carries no reconciliation at all", () => {
    const ur = { unitRef: "unit_a", outcome: "INDETERMINATE" } as UnitResult;
    expect(() => assertReconciliationContractHonored(ur)).toThrow(MseViolation);
  });

  it("throws MseViolation when mode is MACHINE_RESOLVABLE but correlationId is missing", () => {
    const ur: UnitResult = {
      unitRef: "unit_a",
      outcome: "INDETERMINATE",
      reconciliation: { mode: "MACHINE_RESOLVABLE" },
    };
    expect(() => assertReconciliationContractHonored(ur)).toThrow(MseViolation);
  });

  it("throws MseViolation when mode is AUTHORITATIVE_READ but correlationId is missing", () => {
    const ur: UnitResult = {
      unitRef: "unit_a",
      outcome: "INDETERMINATE",
      reconciliation: { mode: "AUTHORITATIVE_READ" },
    };
    expect(() => assertReconciliationContractHonored(ur)).toThrow(MseViolation);
  });

  it("throws MseViolation when mode is NONE but a correlationId is present anyway", () => {
    const ur: UnitResult = {
      unitRef: "unit_a",
      outcome: "INDETERMINATE",
      reconciliation: { mode: "NONE", correlationId: "corr_1" },
    };
    expect(() => assertReconciliationContractHonored(ur)).toThrow(MseViolation);
  });

  it("throws MseViolation when an INDETERMINATE unit claims committedEffects", () => {
    const ur = {
      unitRef: "unit_a",
      outcome: "INDETERMINATE",
      reconciliation: { mode: "NONE" },
      committedEffects: [
        { effectId: "eff_1", type: "retail:order_total_delta", value: money("1.00"), guarantee: { mode: "EXACT" } },
      ],
    } as unknown as UnitResult;
    expect(() => assertReconciliationContractHonored(ur)).toThrow(MseViolation);
  });

  it("throws MseViolation when a non-INDETERMINATE unit carries a reconciliation", () => {
    const ur = {
      unitRef: "unit_a",
      outcome: "APPLIED",
      committedEffects: [],
      reconciliation: { mode: "NONE" },
    } as unknown as UnitResult;
    expect(() => assertReconciliationContractHonored(ur)).toThrow(MseViolation);
  });

  it("throws MseViolation when a REFUSED unit carries committedEffects", () => {
    const ur = {
      unitRef: "unit_a",
      outcome: "REFUSED",
      refusalReason: "PROVIDER_REJECTED",
      committedEffects: [
        { effectId: "eff_1", type: "retail:order_total_delta", value: money("1.00"), guarantee: { mode: "EXACT" } },
      ],
    } as unknown as UnitResult;
    expect(() => assertReconciliationContractHonored(ur)).toThrow(MseViolation);
  });

  it("throws MseViolation when an APPLIED unit omits committedEffects", () => {
    const ur = { unitRef: "unit_a", outcome: "APPLIED" } as unknown as UnitResult;
    expect(() => assertReconciliationContractHonored(ur)).toThrow(MseViolation);
  });
});

describe("evaluateAcceptanceConstraints — correlated by effectId across units", () => {
  it("passes when a same-currency money bound is satisfied", () => {
    const quote = baseQuote({
      units: [
        unit("unit_a", [
          { effectId: "eff_1", type: "travel:fare_delta", value: money("120.00"), guarantee: { mode: "EXACT" } },
        ]),
      ],
    });
    const constraints: AcceptanceConstraint[] = [
      { effectId: "eff_1", operator: "<=", value: money("150.00") },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toEqual([]);
  });

  it("fails when a same-currency money bound is violated", () => {
    const quote = baseQuote({
      units: [
        unit("unit_a", [
          { effectId: "eff_1", type: "travel:fare_delta", value: money("180.00"), guarantee: { mode: "EXACT" } },
        ]),
      ],
    });
    const constraints: AcceptanceConstraint[] = [
      { effectId: "eff_1", operator: "<=", value: money("150.00") },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toHaveLength(1);
  });

  it("fails closed on currency mismatch even when the amount would satisfy the bound", () => {
    const quote = baseQuote({
      units: [
        unit("unit_a", [
          { effectId: "eff_1", type: "travel:fare_delta", value: money("10.00", "EUR"), guarantee: { mode: "EXACT" } },
        ]),
      ],
    });
    const constraints: AcceptanceConstraint[] = [
      { effectId: "eff_1", operator: "<=", value: money("150.00", "USD") },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toHaveLength(1);
  });

  it("fails closed on an incompatible ComparableValue variant", () => {
    const quote = baseQuote({
      units: [
        unit("unit_a", [
          { effectId: "eff_1", type: "travel:fare_delta", value: { type: "number", value: 120 }, guarantee: { mode: "EXACT" } },
        ]),
      ],
    });
    const constraints: AcceptanceConstraint[] = [
      { effectId: "eff_1", operator: "<=", value: money("150.00") },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toHaveLength(1);
  });

  it("handles a decimal-precision edge case correctly (no float rounding error)", () => {
    const quote = baseQuote({
      units: [
        unit("unit_a", [
          { effectId: "eff_1", type: "retail:order_total_delta", value: money("20.01"), guarantee: { mode: "EXACT" } },
        ]),
      ],
    });
    const atBound: AcceptanceConstraint[] = [{ effectId: "eff_1", operator: "<=", value: money("20.01") }];
    const justUnder: AcceptanceConstraint[] = [{ effectId: "eff_1", operator: "<=", value: money("20.00") }];
    expect(evaluateAcceptanceConstraints(quote, atBound)).toEqual([]);
    expect(evaluateAcceptanceConstraints(quote, justUnder)).toHaveLength(1);
  });

  it("fails closed when the effect is missing from the quote (no effectId match in any unit)", () => {
    const quote = baseQuote();
    const constraints: AcceptanceConstraint[] = [
      { effectId: "eff_nonexistent", operator: "<=", value: money("100.00") },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toHaveLength(1);
  });

  it("fails closed when the effect's guarantee is UNKNOWN", () => {
    const quote = baseQuote({
      units: [
        unit("unit_a", [
          { effectId: "eff_1", type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "UNKNOWN" } },
        ]),
      ],
    });
    const constraints: AcceptanceConstraint[] = [
      { effectId: "eff_1", operator: "<=", value: money("100.00") },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toHaveLength(1);
  });

  it("fails closed when the effect value isn't shaped as a ComparableValue at all", () => {
    const quote = baseQuote({
      units: [
        unit("unit_a", [
          { effectId: "eff_1", type: "retail:order_total_delta", value: "not-a-comparable-value", guarantee: { mode: "EXACT" } },
        ]),
      ],
    });
    const constraints: AcceptanceConstraint[] = [
      { effectId: "eff_1", operator: "<=", value: money("100.00") },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toHaveLength(1);
  });

  it("correlates by effectId even when two units share the same effectType", () => {
    const quote = baseQuote({
      units: [
        unit("unit_a", [
          { effectId: "eff_a", type: "retail:order_total_delta", value: money("10.00"), guarantee: { mode: "EXACT" } },
        ]),
        unit("unit_b", [
          { effectId: "eff_b", type: "retail:order_total_delta", value: money("999.00"), guarantee: { mode: "EXACT" } },
        ]),
      ],
    });
    // Constraint targets unit_a's effect specifically; unit_b's much larger
    // same-typed effect must not be confused with it.
    const constraints: AcceptanceConstraint[] = [
      { effectId: "eff_a", operator: "<=", value: money("20.00") },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toEqual([]);
  });

  it("passes trivially with an empty constraint list", () => {
    expect(evaluateAcceptanceConstraints(baseQuote(), [])).toEqual([]);
  });
});

describe("isQuoteExpired", () => {
  it("is false when expiresAt is absent", () => {
    expect(isQuoteExpired(baseQuote())).toBe(false);
  });

  it("is true when now is after expiresAt", () => {
    const quote = baseQuote({ expiresAt: "2020-01-01T00:00:00Z" });
    expect(isQuoteExpired(quote, new Date("2021-01-01T00:00:00Z"))).toBe(true);
  });

  it("is false when now is before expiresAt", () => {
    const quote = baseQuote({ expiresAt: "2099-01-01T00:00:00Z" });
    expect(isQuoteExpired(quote, new Date("2021-01-01T00:00:00Z"))).toBe(false);
  });
});

describe("assertExactGuaranteesHonored — now scoped per unit", () => {
  it("does not throw when EXACT effects are unchanged", () => {
    const quote = baseQuote();
    const ur: UnitResult = {
      unitRef: "unit_a",
      outcome: "APPLIED",
      committedEffects: [
        { effectId: "eff_a1", type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "EXACT" } },
      ],
    };
    expect(() => assertExactGuaranteesHonored(quote, ur)).not.toThrow();
  });

  it("throws MseViolation when an EXACT effect's value drifts", () => {
    const quote = baseQuote();
    const ur: UnitResult = {
      unitRef: "unit_a",
      outcome: "APPLIED",
      committedEffects: [
        { effectId: "eff_a1", type: "retail:order_total_delta", value: money("43.00"), guarantee: { mode: "EXACT" } },
      ],
    };
    expect(() => assertExactGuaranteesHonored(quote, ur)).toThrow(MseViolation);
  });

  it("throws MseViolation when an EXACT effect is missing from committedEffects", () => {
    const quote = baseQuote();
    const ur: UnitResult = { unitRef: "unit_a", outcome: "APPLIED", committedEffects: [] };
    expect(() => assertExactGuaranteesHonored(quote, ur)).toThrow(MseViolation);
  });

  it("is a no-op when outcome is not APPLIED", () => {
    const quote = baseQuote();
    const ur: UnitResult = { unitRef: "unit_a", outcome: "REFUSED", refusalReason: "QUOTE_EXPIRED" };
    expect(() => assertExactGuaranteesHonored(quote, ur)).not.toThrow();
  });
});

describe("assertReceiptCoversAllCommittedEffects — full correlation chain (spec §7b)", () => {
  it("does not throw when every committed effect (across all units) appears in the receipt with the correct unitRef", () => {
    const unitResults: UnitResult[] = [
      { unitRef: "unit_a", outcome: "APPLIED", committedEffects: [{ effectId: "eff_a1", type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "EXACT" } }] },
      { unitRef: "unit_b", outcome: "APPLIED", committedEffects: [{ effectId: "eff_b1", type: "retail:order_total_delta", value: money("10.00"), guarantee: { mode: "EXACT" } }] },
    ];
    expect(() =>
      assertReceiptCoversAllCommittedEffects(unitResults, [
        { effectId: "eff_a1", unitRef: "unit_a" },
        { effectId: "eff_b1", unitRef: "unit_b" },
      ])
    ).not.toThrow();
  });

  it("throws MseViolation when a committed effect silently disappears from the receipt", () => {
    const unitResults: UnitResult[] = [
      { unitRef: "unit_a", outcome: "APPLIED", committedEffects: [{ effectId: "eff_a1", type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "EXACT" } }] },
      { unitRef: "unit_b", outcome: "APPLIED", committedEffects: [{ effectId: "eff_b1", type: "retail:refund_amount", value: money("10.00"), guarantee: { mode: "REVALIDATE" } }] },
    ];
    expect(() =>
      assertReceiptCoversAllCommittedEffects(unitResults, [{ effectId: "eff_a1", unitRef: "unit_a" }])
    ).toThrow(MseViolation);
  });

  it("does not throw when an untrackable effect is present with finality UNKNOWN rather than omitted", () => {
    const unitResults: UnitResult[] = [
      { unitRef: "unit_a", outcome: "APPLIED", committedEffects: [{ effectId: "eff_a1", type: "retail:refund_amount", value: money("10.00"), guarantee: { mode: "REVALIDATE" } }] },
    ];
    expect(() =>
      assertReceiptCoversAllCommittedEffects(unitResults, [{ effectId: "eff_a1", unitRef: "unit_a" }])
    ).not.toThrow();
  });

  it("REFUSED and INDETERMINATE units contribute no committedEffects to check", () => {
    const unitResults: UnitResult[] = [
      { unitRef: "unit_a", outcome: "REFUSED", refusalReason: "PROVIDER_REJECTED" },
      { unitRef: "unit_b", outcome: "INDETERMINATE", reconciliation: { mode: "NONE" } },
    ];
    expect(() => assertReceiptCoversAllCommittedEffects(unitResults, [])).not.toThrow();
  });

  // (A) correct effectId + wrong unitRef in an EffectReceipt -> violation.
  it("(A) throws MseViolation when a receipt names the correct effectId under the wrong unitRef", () => {
    const unitResults: UnitResult[] = [
      { unitRef: "unit_a", outcome: "APPLIED", committedEffects: [{ effectId: "eff_a1", type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "EXACT" } }] },
      { unitRef: "unit_b", outcome: "APPLIED", committedEffects: [{ effectId: "eff_b1", type: "retail:order_total_delta", value: money("10.00"), guarantee: { mode: "EXACT" } }] },
    ];
    // eff_a1 genuinely exists and was genuinely committed — just under unit_a, not unit_b.
    expect(() =>
      assertReceiptCoversAllCommittedEffects(unitResults, [
        { effectId: "eff_a1", unitRef: "unit_b" },
        { effectId: "eff_b1", unitRef: "unit_b" },
      ])
    ).toThrow(MseViolation);
  });

  // (C) completely unknown committed effectId -> violation.
  it("(C) throws MseViolation when a receipt names an effectId that was never committed by any unit", () => {
    const unitResults: UnitResult[] = [
      { unitRef: "unit_a", outcome: "APPLIED", committedEffects: [{ effectId: "eff_a1", type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "EXACT" } }] },
    ];
    expect(() =>
      assertReceiptCoversAllCommittedEffects(unitResults, [
        { effectId: "eff_a1", unitRef: "unit_a" },
        { effectId: "eff_nonexistent", unitRef: "unit_a" },
      ])
    ).toThrow(MseViolation);
  });

  // (D) duplicate EffectReceipt for the same effectId -> violation.
  it("(D) throws MseViolation on a duplicate EffectReceipt for the same effectId", () => {
    const unitResults: UnitResult[] = [
      { unitRef: "unit_a", outcome: "APPLIED", committedEffects: [{ effectId: "eff_a1", type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "EXACT" } }] },
    ];
    expect(() =>
      assertReceiptCoversAllCommittedEffects(unitResults, [
        { effectId: "eff_a1", unitRef: "unit_a" },
        { effectId: "eff_a1", unitRef: "unit_a" },
      ])
    ).toThrow(MseViolation);
  });

  // (E) EffectReceipt for an effect that was not committed (only quoted, or entirely absent) -> violation.
  it("(E) throws MseViolation for a receipt entry whose effect was never committed by this CommitResult", () => {
    const unitResults: UnitResult[] = [
      { unitRef: "unit_a", outcome: "REFUSED", refusalReason: "CONSTRAINT_VIOLATED" }, // nothing committed
    ];
    expect(() =>
      assertReceiptCoversAllCommittedEffects(unitResults, [{ effectId: "eff_a1", unitRef: "unit_a" }])
    ).toThrow(MseViolation);
  });

  // (F) happy path: two units share an effectType but have distinct effectIds
  // and correct unitRefs -> passes.
  it("(F) passes when two units produce the same effectType under distinct effectIds with correct unitRefs", () => {
    const unitResults: UnitResult[] = [
      { unitRef: "unit_a", outcome: "APPLIED", committedEffects: [{ effectId: "eff_a1", type: "retail:order_total_delta", value: money("10.00"), guarantee: { mode: "EXACT" } }] },
      { unitRef: "unit_b", outcome: "APPLIED", committedEffects: [{ effectId: "eff_b1", type: "retail:order_total_delta", value: money("20.00"), guarantee: { mode: "EXACT" } }] },
    ];
    expect(() =>
      assertReceiptCoversAllCommittedEffects(unitResults, [
        { effectId: "eff_a1", unitRef: "unit_a" },
        { effectId: "eff_b1", unitRef: "unit_b" },
      ])
    ).not.toThrow();
  });
});

describe("assertCommittedEffectsBelongToUnits — committed-effect ownership (spec §7b)", () => {
  function quoteWithTwoUnits(): MutationQuote {
    return baseQuote({
      units: [
        unit("unit_a", [
          { effectId: "eff_a1", type: "retail:order_total_delta", value: money("10.00"), guarantee: { mode: "EXACT" } },
        ]),
        unit("unit_b", [
          { effectId: "eff_b1", type: "retail:order_total_delta", value: money("20.00"), guarantee: { mode: "EXACT" } },
        ]),
      ],
    });
  }

  it("does not throw when every committed effect belongs to the unit that claims it", () => {
    const quote = quoteWithTwoUnits();
    const result = {
      quoteId: quote.quoteId,
      unitResults: [
        { unitRef: "unit_a", outcome: "APPLIED" as const, committedEffects: [quote.units[0].effects[0]] },
        { unitRef: "unit_b", outcome: "APPLIED" as const, committedEffects: [quote.units[1].effects[0]] },
      ],
    };
    expect(() => assertCommittedEffectsBelongToUnits(quote, result)).not.toThrow();
  });

  // (B) committed effect belongs to a different quoted unit -> violation.
  it("(B) throws MseViolation when a committed effect quoted under unit A is claimed by unit B", () => {
    const quote = quoteWithTwoUnits();
    const result = {
      quoteId: quote.quoteId,
      unitResults: [
        // eff_a1 was quoted under unit_a, but this CommitResult claims it under unit_b.
        { unitRef: "unit_a", outcome: "APPLIED" as const, committedEffects: [] },
        { unitRef: "unit_b", outcome: "APPLIED" as const, committedEffects: [quote.units[0].effects[0]] },
      ],
    };
    expect(() => assertCommittedEffectsBelongToUnits(quote, result)).toThrow(MseViolation);
  });

  it("throws MseViolation when a committed effectId was never quoted at all", () => {
    const quote = quoteWithTwoUnits();
    const result = {
      quoteId: quote.quoteId,
      unitResults: [
        {
          unitRef: "unit_a",
          outcome: "APPLIED" as const,
          committedEffects: [
            { effectId: "eff_never_quoted", type: "retail:order_total_delta", value: money("1.00"), guarantee: { mode: "EXACT" as const } },
          ],
        },
      ],
    };
    expect(() => assertCommittedEffectsBelongToUnits(quote, result)).toThrow(MseViolation);
  });

  it("throws MseViolation when the same committed effectId is claimed by two different unitResults", () => {
    const quote = quoteWithTwoUnits();
    const result = {
      quoteId: quote.quoteId,
      unitResults: [
        { unitRef: "unit_a", outcome: "APPLIED" as const, committedEffects: [quote.units[0].effects[0]] },
        // Same effectId claimed again, even under its own correct unitRef — still a double-claim.
        { unitRef: "unit_a", outcome: "APPLIED" as const, committedEffects: [quote.units[0].effects[0]] },
      ],
    };
    expect(() => assertCommittedEffectsBelongToUnits(quote, result)).toThrow(MseViolation);
  });
});

describe("computeAggregateHint / assertAggregateHintConsistent — spec §1c derivation rule", () => {
  it("derives ALL_APPLIED when every unit is APPLIED", () => {
    const unitResults: UnitResult[] = [
      { unitRef: "unit_a", outcome: "APPLIED", committedEffects: [] },
      { unitRef: "unit_b", outcome: "APPLIED", committedEffects: [] },
    ];
    expect(computeAggregateHint(unitResults)).toBe("ALL_APPLIED");
  });

  it("derives ALL_REFUSED when every unit is REFUSED", () => {
    const unitResults: UnitResult[] = [
      { unitRef: "unit_a", outcome: "REFUSED", refusalReason: "CONSTRAINT_VIOLATED" },
      { unitRef: "unit_b", outcome: "REFUSED", refusalReason: "QUOTE_EXPIRED" },
    ];
    expect(computeAggregateHint(unitResults)).toBe("ALL_REFUSED");
  });

  it("derives ALL_INDETERMINATE when every unit is INDETERMINATE", () => {
    const unitResults: UnitResult[] = [
      { unitRef: "unit_a", outcome: "INDETERMINATE", reconciliation: { mode: "NONE" } },
      { unitRef: "unit_b", outcome: "INDETERMINATE", reconciliation: { mode: "NONE" } },
    ];
    expect(computeAggregateHint(unitResults)).toBe("ALL_INDETERMINATE");
  });

  it("derives MIXED for any non-uniform combination of outcomes", () => {
    expect(
      computeAggregateHint([
        { unitRef: "unit_a", outcome: "APPLIED", committedEffects: [] },
        { unitRef: "unit_b", outcome: "REFUSED", refusalReason: "CONSTRAINT_VIOLATED" },
      ])
    ).toBe("MIXED");
    expect(
      computeAggregateHint([
        { unitRef: "unit_a", outcome: "APPLIED", committedEffects: [] },
        { unitRef: "unit_b", outcome: "INDETERMINATE", reconciliation: { mode: "NONE" } },
      ])
    ).toBe("MIXED");
    expect(
      computeAggregateHint([
        { unitRef: "unit_a", outcome: "REFUSED", refusalReason: "CONSTRAINT_VIOLATED" },
        { unitRef: "unit_b", outcome: "INDETERMINATE", reconciliation: { mode: "NONE" } },
      ])
    ).toBe("MIXED");
  });

  it("derives the correct hint for the degenerate single-unit case", () => {
    expect(
      computeAggregateHint([{ unitRef: "unit_a", outcome: "APPLIED", committedEffects: [] }])
    ).toBe("ALL_APPLIED");
  });

  it("assertAggregateHintConsistent does not throw when aggregateHint is absent", () => {
    const result = {
      quoteId: "q1",
      unitResults: [{ unitRef: "unit_a", outcome: "APPLIED" as const, committedEffects: [] }],
    };
    expect(() => assertAggregateHintConsistent(result)).not.toThrow();
  });

  it("assertAggregateHintConsistent does not throw when aggregateHint agrees with unitResults", () => {
    const result = {
      quoteId: "q1",
      unitResults: [
        { unitRef: "unit_a", outcome: "APPLIED" as const, committedEffects: [] },
        { unitRef: "unit_b", outcome: "REFUSED" as const, refusalReason: "CONSTRAINT_VIOLATED" as const },
      ],
      aggregateHint: "MIXED" as const,
    };
    expect(() => assertAggregateHintConsistent(result)).not.toThrow();
  });

  it("assertAggregateHintConsistent throws MseViolation when aggregateHint contradicts unitResults", () => {
    // A provider incorrectly claims ALL_APPLIED while one unit was actually REFUSED.
    const result = {
      quoteId: "q1",
      unitResults: [
        { unitRef: "unit_a", outcome: "APPLIED" as const, committedEffects: [] },
        { unitRef: "unit_b", outcome: "REFUSED" as const, refusalReason: "CONSTRAINT_VIOLATED" as const },
      ],
      aggregateHint: "ALL_APPLIED" as const,
    };
    expect(() => assertAggregateHintConsistent(result)).toThrow(MseViolation);
  });

  it("assertAggregateHintConsistent throws MseViolation when aggregateHint claims MIXED but unitResults are actually uniform", () => {
    const result = {
      quoteId: "q1",
      unitResults: [
        { unitRef: "unit_a", outcome: "APPLIED" as const, committedEffects: [] },
        { unitRef: "unit_b", outcome: "APPLIED" as const, committedEffects: [] },
      ],
      aggregateHint: "MIXED" as const,
    };
    expect(() => assertAggregateHintConsistent(result)).toThrow(MseViolation);
  });
});

describe("ReferenceProvider — full lifecycle, per-unit commit results", () => {
  it("(C) all units APPLIED: proposal -> quote -> commit -> receipt", () => {
    const provider = new ReferenceProvider((proposal) => ({
      target: proposal.target,
      units: [
        unit("unit_a", [
          { effectId: "eff_a1", type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "EXACT" } },
        ]),
      ],
    }));

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });
    const commitResult = committed(provider.commit({
      quoteId: quote.quoteId,
      acceptanceConstraints: [{ effectId: "eff_a1", operator: "<=", value: money("100.00") }],
    }));

    expect(() => assertCommitResultCoversAllUnits(quote, commitResult)).not.toThrow();
    expect(commitResult.unitResults).toHaveLength(1);
    expect(commitResult.unitResults[0].outcome).toBe("APPLIED");
    expect(() => assertExactGuaranteesHonored(quote, commitResult.unitResults[0])).not.toThrow();
    expect(() => assertCommittedEffectsBelongToUnits(quote, commitResult)).not.toThrow();
    expect(commitResult.aggregateHint).toBe("ALL_APPLIED");
    expect(() => assertAggregateHintConsistent(commitResult)).not.toThrow();

    const receipt = provider.receipt(quote.quoteId);
    expect(receipt.effectReceipts[0].finality).toBe("FINAL");
    expect(() =>
      assertReceiptCoversAllCommittedEffects(commitResult.unitResults, receipt.effectReceipts)
    ).not.toThrow();
  });

  it("(A) two units: APPLIED + REFUSED in the same commit attempt", () => {
    const provider = new ReferenceProvider((proposal) => ({
      target: proposal.target,
      units: [
        unit("unit_ok", [
          { effectId: "eff_ok", type: "retail:order_total_delta", value: money("10.00"), guarantee: { mode: "EXACT" } },
        ]),
        unit("unit_over_budget", [
          { effectId: "eff_over", type: "travel:fare_delta", value: money("999.00"), guarantee: { mode: "EXACT" } },
        ]),
      ],
    }));

    const quote = provider.quote({ proposalId: "p1", target: { pnr: "ABC123" }, change: {} });
    const commitResult = committed(provider.commit({
      quoteId: quote.quoteId,
      acceptanceConstraints: [{ effectId: "eff_over", operator: "<=", value: money("150.00") }],
    }));

    expect(() => assertCommitResultCoversAllUnits(quote, commitResult)).not.toThrow();

    const okResult = commitResult.unitResults.find((r) => r.unitRef === "unit_ok")!;
    const overResult = commitResult.unitResults.find((r) => r.unitRef === "unit_over_budget")!;

    expect(okResult.outcome).toBe("APPLIED");
    expect(overResult.outcome).toBe("REFUSED");
    expect(overResult.refusalReason).toBe("CONSTRAINT_VIOLATED");

    // (K) mixed results must not collapse into a single overall flag.
    expect(commitResult).not.toHaveProperty("outcome");
    const outcomes = new Set(commitResult.unitResults.map((r) => r.outcome));
    expect(outcomes.size).toBeGreaterThan(1);

    // aggregateHint, if emitted, must correctly say MIXED and must never
    // contradict unitResults (spec §1c).
    expect(commitResult.aggregateHint).toBe("MIXED");
    expect(() => assertAggregateHintConsistent(commitResult)).not.toThrow();
  });

  it("(B) two units: APPLIED + INDETERMINATE in the same commit attempt", () => {
    const provider = new ReferenceProvider(
      (proposal) => ({
        target: proposal.target,
        units: [
          unit("unit_fast", [
            { effectId: "eff_fast", type: "retail:order_total_delta", value: money("10.00"), guarantee: { mode: "EXACT" } },
          ]),
          unit("unit_slow", [
            { effectId: "eff_slow", type: "retail:order_total_delta", value: money("20.00"), guarantee: { mode: "EXACT" } },
          ]),
        ],
      }),
      {},
      {
        shouldTimeout: (_req, _quote, u) => u.unitRef === "unit_slow",
        reconciliationOutcome: () => "APPLIED",
      }
    );

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });
    const commitResult = committed(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    );

    expect(() => assertCommitResultCoversAllUnits(quote, commitResult)).not.toThrow();

    const fastResult = commitResult.unitResults.find((r) => r.unitRef === "unit_fast")!;
    const slowResult = commitResult.unitResults.find((r) => r.unitRef === "unit_slow")!;

    expect(fastResult.outcome).toBe("APPLIED");
    expect(slowResult.outcome).toBe("INDETERMINATE");
    expect(slowResult.committedEffects).toBeUndefined();
    expect(() => assertReconciliationContractHonored(slowResult)).not.toThrow();
    expect(() => assertReconciliationContractHonored(fastResult)).not.toThrow();

    expect(commitResult.aggregateHint).toBe("MIXED");
    expect(() => assertAggregateHintConsistent(commitResult)).not.toThrow();
  });

  it("(D) all units REFUSED (quote expired short-circuits every unit)", () => {
    const provider = new ReferenceProvider((proposal) => ({
      target: proposal.target,
      units: [unit("unit_a", []), unit("unit_b", [])],
      expiresAt: "2020-01-01T00:00:00Z",
    }));

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });
    const commitResult = committed(provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] },
      new Date("2021-01-01T00:00:00Z")
    ));

    expect(() => assertCommitResultCoversAllUnits(quote, commitResult)).not.toThrow();
    expect(commitResult.unitResults.every((r) => r.outcome === "REFUSED")).toBe(true);
    expect(commitResult.unitResults.every((r) => r.refusalReason === "QUOTE_EXPIRED")).toBe(true);
    expect(commitResult.aggregateHint).toBe("ALL_REFUSED");
    expect(() => assertAggregateHintConsistent(commitResult)).not.toThrow();
  });

  it("REFUSED path: snapshot mismatch under SNAPSHOT_REQUIRED applies to every unit", () => {
    const provider = new ReferenceProvider((proposal) => ({
      target: proposal.target,
      snapshot: "v1",
      units: [unit("unit_a", [])],
      commitConsistency: "SNAPSHOT_REQUIRED",
    }));

    const target = { orderId: "o1" };
    provider.setSnapshot(target, "v2");

    const quote = provider.quote({ proposalId: "p1", target, change: {} });
    const commitResult = committed(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    );

    expect(commitResult.unitResults[0].outcome).toBe("REFUSED");
    expect(commitResult.unitResults[0].refusalReason).toBe("SNAPSHOT_MISMATCH");
  });

  it("REFUSED with a namespaced provider-specific extension reason", () => {
    const ur: UnitResult = {
      unitRef: "unit_a",
      outcome: "REFUSED",
      refusalReason: "travel:fare_class_closed",
    };
    expect(ur.refusalReason).toBe("travel:fare_class_closed");
  });

  it("(J) APPLIED unit with a PENDING downstream effect", () => {
    const provider = new ReferenceProvider(
      (proposal) => ({
        target: proposal.target,
        units: [
          unit("unit_a", [
            { effectId: "eff_delta", type: "retail:order_total_delta", value: money("-20.00"), guarantee: { mode: "EXACT" } },
            { effectId: "eff_refund", type: "retail:refund_amount", value: money("20.00"), guarantee: { mode: "REVALIDATE" } },
          ]),
        ],
      }),
      {
        onReceipt: (_quote, unitResults) =>
          unitResults.flatMap((ur) =>
            (ur.committedEffects ?? []).map(
              (e): EffectReceipt => ({
                effectId: e.effectId,
                unitRef: ur.unitRef,
                finality: e.effectId === "eff_refund" ? "PENDING" : "FINAL",
                value: e.value,
              })
            )
          ),
      }
    );

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });
    const commitResult = committed(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    );
    const receipt = provider.receipt(quote.quoteId);

    expect(commitResult.unitResults[0].outcome).toBe("APPLIED");
    const refundReceipt = receipt.effectReceipts.find((r) => r.effectId === "eff_refund");
    expect(refundReceipt?.finality).toBe("PENDING");
  });

  it("(G) reconciliation resolving INDETERMINATE -> APPLIED without replay", () => {
    const provider = new ReferenceProvider(
      (proposal) => ({
        target: proposal.target,
        units: [unit("unit_a", [{ effectId: "eff_1", type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "EXACT" } }])],
      }),
      {},
      {
        shouldTimeout: () => true,
        reconciliationOutcome: () => "APPLIED",
      }
    );

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });
    const commitResult = committed(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    );
    const unitResult = commitResult.unitResults[0];

    expect(unitResult.outcome).toBe("INDETERMINATE");
    expect(unitResult.committedEffects).toBeUndefined();
    const correlationId = unitResult.reconciliation?.correlationId;
    expect(correlationId).toBeTruthy();

    const resolved = provider.reconcile(correlationId!);
    expect(resolved).toBe("APPLIED");

    // Reflected in a subsequent receipt without a second commit() call —
    // i.e. resolved via read/status-check, not replay.
    const receipt = provider.receipt(quote.quoteId);
    expect(receipt.effectReceipts.find((r) => r.effectId === "eff_1")).toBeDefined();
  });

  it("(H) reconciliation resolving INDETERMINATE -> REFUSED without replay", () => {
    const provider = new ReferenceProvider(
      (proposal) => ({
        target: proposal.target,
        units: [unit("unit_a", [{ effectId: "eff_1", type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "EXACT" } }])],
      }),
      {},
      {
        shouldTimeout: () => true,
        reconciliationOutcome: () => "REFUSED",
      }
    );

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });
    const commitResult = committed(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    );
    const correlationId = commitResult.unitResults[0].reconciliation?.correlationId!;

    const resolved = provider.reconcile(correlationId);
    expect(resolved).toBe("REFUSED");

    const receipt = provider.receipt(quote.quoteId);
    // A REFUSED unit has no committed effects to receipt.
    expect(receipt.effectReceipts.find((r) => r.effectId === "eff_1")).toBeUndefined();
  });

  it("(I) reconciliation can remain unresolved (not deterministically APPLIED)", () => {
    const provider = new ReferenceProvider(
      (proposal) => ({
        target: proposal.target,
        units: [unit("unit_a", [{ effectId: "eff_1", type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "EXACT" } }])],
      }),
      {},
      {
        shouldTimeout: () => true,
        reconciliationOutcome: () => undefined, // still unresolvable
      }
    );

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });
    const commitResult = committed(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    );
    const unitResult = commitResult.unitResults[0];

    // No reconciliationOutcome handler at all -> mode NONE, no correlationId.
    expect(unitResult.reconciliation?.mode).toBe("MACHINE_RESOLVABLE");
    const correlationId = unitResult.reconciliation?.correlationId!;

    expect(provider.reconcile(correlationId)).toBe("STILL_INDETERMINATE");
    expect(provider.reconcile("never-issued-id")).toBe("STILL_INDETERMINATE");
  });

  it("reports mode NONE when no reconciliation path is configured at all", () => {
    const provider = new ReferenceProvider(
      (proposal) => ({
        target: proposal.target,
        units: [unit("unit_a", [{ effectId: "eff_1", type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "EXACT" } }])],
      }),
      {},
      { shouldTimeout: () => true } // no reconciliationOutcome hook at all
    );

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });
    const commitResult = committed(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    );
    const unitResult = commitResult.unitResults[0];

    expect(unitResult.reconciliation?.mode).toBe("NONE");
    expect(unitResult.reconciliation?.correlationId).toBeUndefined();
  });

  it("receipt fail-clear: the reference provider itself never lets a committed effect disappear", () => {
    const provider = new ReferenceProvider(
      (proposal) => ({
        target: proposal.target,
        units: [
          unit("unit_a", [
            { effectId: "eff_delta", type: "retail:order_total_delta", value: money("10.00"), guarantee: { mode: "EXACT" } },
            { effectId: "eff_refund", type: "retail:refund_amount", value: money("5.00"), guarantee: { mode: "REVALIDATE" } },
          ]),
        ],
      }),
      {
        // A buggy onReceipt override that forgets one effect.
        onReceipt: (_quote, unitResults) => [
          { effectId: "eff_delta", unitRef: unitResults[0].unitRef, finality: "FINAL" as const },
        ],
      }
    );

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });
    const commitResult = committed(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    );
    const receipt = provider.receipt(quote.quoteId);

    expect(() =>
      assertReceiptCoversAllCommittedEffects(commitResult.unitResults, receipt.effectReceipts)
    ).not.toThrow();

    const refundReceipt = receipt.effectReceipts.find((r) => r.effectId === "eff_refund");
    expect(refundReceipt).toBeDefined();
    expect(refundReceipt?.finality).toBe("UNKNOWN");
  });

  it("(L) two effects sharing the same effectType across units remain independently correlatable via receipt", () => {
    const provider = new ReferenceProvider((proposal) => ({
      target: proposal.target,
      units: [
        unit("unit_a", [
          { effectId: "eff_a_delta", type: "retail:order_total_delta", value: money("10.00"), guarantee: { mode: "EXACT" } },
        ]),
        unit("unit_b", [
          { effectId: "eff_b_delta", type: "retail:order_total_delta", value: money("20.00"), guarantee: { mode: "EXACT" } },
        ]),
      ],
    }));

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });
    const commitResult = committed(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    );
    const receipt = provider.receipt(quote.quoteId);

    expect(() => assertCommittedEffectsBelongToUnits(quote, commitResult)).not.toThrow();
    expect(() =>
      assertReceiptCoversAllCommittedEffects(commitResult.unitResults, receipt.effectReceipts)
    ).not.toThrow();

    const aReceipt = receipt.effectReceipts.find((r) => r.effectId === "eff_a_delta");
    const bReceipt = receipt.effectReceipts.find((r) => r.effectId === "eff_b_delta");

    expect(aReceipt).toBeDefined();
    expect(bReceipt).toBeDefined();
    expect(aReceipt?.unitRef).toBe("unit_a");
    expect(bReceipt?.unitRef).toBe("unit_b");
    expect(aReceipt?.value).toEqual(money("10.00"));
    expect(bReceipt?.value).toEqual(money("20.00"));
  });
});
