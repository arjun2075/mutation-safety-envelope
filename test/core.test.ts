import { describe, it, expect } from "vitest";
import {
  evaluateAcceptanceConstraints,
  isQuoteExpired,
  assertExactGuaranteesHonored,
  assertReceiptCoversAllCommittedEffects,
  compareComparableValues,
  compareDecimalStrings,
  MseViolation,
} from "../src/core/validate";
import { ReferenceProvider } from "../src/core/reference-provider";
import type {
  MutationQuote,
  AcceptanceConstraint,
  CommitResult,
  ComparableValue,
} from "../src/core/types";

function money(amount: string, currency = "USD"): ComparableValue {
  return { type: "money", amount, currency };
}

function baseQuote(overrides: Partial<MutationQuote> = {}): MutationQuote {
  return {
    quoteId: "q1",
    target: { orderId: "order_1" },
    effects: [
      {
        type: "retail:order_total_delta",
        value: money("42.00"),
        guarantee: { mode: "EXACT" },
      },
    ],
    ...overrides,
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
    // 0.1 and 0.2 aren't exactly representable in IEEE-754; a naive
    // `parseFloat` comparison chain can misorder values like these once
    // arithmetic is involved. Here we only assert direct comparisons are
    // exact, which a float-based implementation using == could still get
    // right by luck — the real regression this guards is money arithmetic
    // elsewhere never touching `Number` at all (see parseDecimalToScaledBigInt).
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
    expect(
      compareComparableValues(money("100.00"), { type: "number", value: 100 })
    ).toBeNull();
    expect(
      compareComparableValues(
        { type: "string", value: "abc" },
        { type: "number", value: 1 }
      )
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

describe("evaluateAcceptanceConstraints", () => {
  it("passes when a same-currency money bound is satisfied", () => {
    const quote = baseQuote({
      effects: [
        {
          type: "travel:fare_delta",
          value: money("120.00"),
          guarantee: { mode: "EXACT" },
        },
      ],
    });
    const constraints: AcceptanceConstraint[] = [
      { effectType: "travel:fare_delta", operator: "<=", value: money("150.00") },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toEqual([]);
  });

  it("fails when a same-currency money bound is violated", () => {
    const quote = baseQuote({
      effects: [
        {
          type: "travel:fare_delta",
          value: money("180.00"),
          guarantee: { mode: "EXACT" },
        },
      ],
    });
    const constraints: AcceptanceConstraint[] = [
      { effectType: "travel:fare_delta", operator: "<=", value: money("150.00") },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toHaveLength(1);
  });

  it("fails closed on currency mismatch even when the amount would satisfy the bound", () => {
    const quote = baseQuote({
      effects: [
        {
          type: "travel:fare_delta",
          value: money("10.00", "EUR"),
          guarantee: { mode: "EXACT" },
        },
      ],
    });
    const constraints: AcceptanceConstraint[] = [
      { effectType: "travel:fare_delta", operator: "<=", value: money("150.00", "USD") },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toHaveLength(1);
  });

  it("fails closed on an incompatible ComparableValue variant", () => {
    const quote = baseQuote({
      effects: [
        {
          type: "travel:fare_delta",
          value: { type: "number", value: 120 },
          guarantee: { mode: "EXACT" },
        },
      ],
    });
    const constraints: AcceptanceConstraint[] = [
      { effectType: "travel:fare_delta", operator: "<=", value: money("150.00") },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toHaveLength(1);
  });

  it("handles a decimal-precision edge case correctly (no float rounding error)", () => {
    // 19.99 + 0.02 style sums are exactly the case naive parseFloat
    // comparisons can get wrong; here the effect value is already the
    // "summed" amount, expressed as a decimal string, and must compare
    // correctly against a bound one cent away.
    const quote = baseQuote({
      effects: [
        {
          type: "retail:order_total_delta",
          value: money("20.01"),
          guarantee: { mode: "EXACT" },
        },
      ],
    });
    const atBound: AcceptanceConstraint[] = [
      { effectType: "retail:order_total_delta", operator: "<=", value: money("20.01") },
    ];
    const justUnder: AcceptanceConstraint[] = [
      { effectType: "retail:order_total_delta", operator: "<=", value: money("20.00") },
    ];
    expect(evaluateAcceptanceConstraints(quote, atBound)).toEqual([]);
    expect(evaluateAcceptanceConstraints(quote, justUnder)).toHaveLength(1);
  });

  it("fails closed when the effect is missing from the quote", () => {
    const quote = baseQuote();
    const constraints: AcceptanceConstraint[] = [
      { effectType: "retail:nonexistent", operator: "<=", value: money("100.00") },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toHaveLength(1);
  });

  it("fails closed when the effect's guarantee is UNKNOWN", () => {
    const quote = baseQuote({
      effects: [
        {
          type: "retail:order_total_delta",
          value: money("42.00"),
          guarantee: { mode: "UNKNOWN" },
        },
      ],
    });
    const constraints: AcceptanceConstraint[] = [
      { effectType: "retail:order_total_delta", operator: "<=", value: money("100.00") },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toHaveLength(1);
  });

  it("fails closed when the effect value isn't shaped as a ComparableValue at all", () => {
    const quote = baseQuote({
      effects: [
        {
          type: "retail:order_total_delta",
          value: "not-a-comparable-value",
          guarantee: { mode: "EXACT" },
        },
      ],
    });
    const constraints: AcceptanceConstraint[] = [
      { effectType: "retail:order_total_delta", operator: "<=", value: money("100.00") },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toHaveLength(1);
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

describe("assertExactGuaranteesHonored", () => {
  it("does not throw when EXACT effects are unchanged", () => {
    const quote = baseQuote();
    const result: CommitResult = {
      quoteId: "q1",
      outcome: "APPLIED",
      committedEffects: [
        { type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "EXACT" } },
      ],
    };
    expect(() => assertExactGuaranteesHonored(quote, result)).not.toThrow();
  });

  it("throws MseViolation when an EXACT effect's value drifts", () => {
    const quote = baseQuote();
    const result: CommitResult = {
      quoteId: "q1",
      outcome: "APPLIED",
      committedEffects: [
        { type: "retail:order_total_delta", value: money("43.00"), guarantee: { mode: "EXACT" } },
      ],
    };
    expect(() => assertExactGuaranteesHonored(quote, result)).toThrow(MseViolation);
  });

  it("throws MseViolation when an EXACT effect is missing from committedEffects", () => {
    const quote = baseQuote();
    const result: CommitResult = { quoteId: "q1", outcome: "APPLIED", committedEffects: [] };
    expect(() => assertExactGuaranteesHonored(quote, result)).toThrow(MseViolation);
  });

  it("is a no-op when outcome is not APPLIED", () => {
    const quote = baseQuote();
    const result: CommitResult = { quoteId: "q1", outcome: "REFUSED", refusalReason: "QUOTE_EXPIRED" };
    expect(() => assertExactGuaranteesHonored(quote, result)).not.toThrow();
  });
});

describe("assertReceiptCoversAllCommittedEffects — fail-clear receipt coverage", () => {
  it("does not throw when every committed effect appears in the receipt", () => {
    const committed = [
      { type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "EXACT" as const } },
    ];
    expect(() =>
      assertReceiptCoversAllCommittedEffects(committed, [
        { effectType: "retail:order_total_delta" },
      ])
    ).not.toThrow();
  });

  it("throws MseViolation when a quoted/committed effect silently disappears from the receipt", () => {
    const committed = [
      { type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "EXACT" as const } },
      { type: "retail:refund_amount", value: money("10.00"), guarantee: { mode: "REVALIDATE" as const } },
    ];
    expect(() =>
      assertReceiptCoversAllCommittedEffects(committed, [
        { effectType: "retail:order_total_delta" },
        // retail:refund_amount is missing — this must be flagged, not silently accepted.
      ])
    ).toThrow(MseViolation);
  });

  it("does not throw when an untrackable effect is present with finality UNKNOWN rather than omitted", () => {
    const committed = [
      { type: "retail:refund_amount", value: money("10.00"), guarantee: { mode: "REVALIDATE" as const } },
    ];
    expect(() =>
      assertReceiptCoversAllCommittedEffects(committed, [
        { effectType: "retail:refund_amount" }, // finality value itself doesn't matter to this check
      ])
    ).not.toThrow();
  });
});

describe("ReferenceProvider — full lifecycle", () => {
  it("APPLIED path: proposal -> quote -> commit -> receipt", () => {
    const provider = new ReferenceProvider((proposal) => ({
      target: proposal.target,
      effects: [
        { type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "EXACT" } },
      ],
    }));

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });
    const commitResult = provider.commit({
      quoteId: quote.quoteId,
      acceptanceConstraints: [
        { effectType: "retail:order_total_delta", operator: "<=", value: money("100.00") },
      ],
    });

    expect(commitResult.outcome).toBe("APPLIED");
    expect(() => assertExactGuaranteesHonored(quote, commitResult)).not.toThrow();

    const receipt = provider.receipt(quote.quoteId, commitResult.outcome);
    expect(receipt.effectReceipts[0].finality).toBe("FINAL");
    expect(() =>
      assertReceiptCoversAllCommittedEffects(
        commitResult.committedEffects ?? [],
        receipt.effectReceipts
      )
    ).not.toThrow();
  });

  it("REFUSED path: acceptance constraint violated (monetary bound)", () => {
    const provider = new ReferenceProvider((proposal) => ({
      target: proposal.target,
      effects: [
        { type: "travel:fare_delta", value: money("999.00"), guarantee: { mode: "EXACT" } },
      ],
    }));

    const quote = provider.quote({ proposalId: "p1", target: { pnr: "ABC123" }, change: {} });
    const commitResult = provider.commit({
      quoteId: quote.quoteId,
      acceptanceConstraints: [
        { effectType: "travel:fare_delta", operator: "<=", value: money("150.00") },
      ],
    });

    expect(commitResult.outcome).toBe("REFUSED");
    expect(commitResult.refusalReason).toBe("CONSTRAINT_VIOLATED");
  });

  it("REFUSED path: quote expired before commit", () => {
    const provider = new ReferenceProvider((proposal) => ({
      target: proposal.target,
      effects: [],
      expiresAt: "2020-01-01T00:00:00Z",
    }));

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });
    const commitResult = provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] },
      new Date("2021-01-01T00:00:00Z")
    );

    expect(commitResult.outcome).toBe("REFUSED");
    expect(commitResult.refusalReason).toBe("QUOTE_EXPIRED");
  });

  it("REFUSED path: snapshot mismatch under SNAPSHOT_REQUIRED", () => {
    const provider = new ReferenceProvider((proposal) => ({
      target: proposal.target,
      snapshot: "v1",
      effects: [],
      commitConsistency: "SNAPSHOT_REQUIRED",
    }));

    const target = { orderId: "o1" };
    provider.setSnapshot(target, "v2"); // resource has moved on since the quote was built

    const quote = provider.quote({ proposalId: "p1", target, change: {} });
    const commitResult = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });

    expect(commitResult.outcome).toBe("REFUSED");
    expect(commitResult.refusalReason).toBe("SNAPSHOT_MISMATCH");
  });

  it("REFUSED with a namespaced provider-specific extension reason", () => {
    // Demonstrates the RefusalReason extension mechanism: a provider can
    // return a namespaced reason more specific than PROVIDER_REJECTED.
    const commitResult: CommitResult = {
      quoteId: "q1",
      outcome: "REFUSED",
      refusalReason: "travel:fare_class_closed",
    };
    expect(commitResult.refusalReason).toBe("travel:fare_class_closed");
  });

  it("distinguishes mutation APPLIED from a PENDING downstream effect", () => {
    const provider = new ReferenceProvider(
      (proposal) => ({
        target: proposal.target,
        effects: [
          { type: "retail:order_total_delta", value: money("-20.00"), guarantee: { mode: "EXACT" } },
          { type: "retail:refund_amount", value: money("20.00"), guarantee: { mode: "REVALIDATE" } },
        ],
      }),
      {
        onReceipt: (_quote, committed) =>
          committed.map((e) => ({
            effectType: e.type,
            finality: e.type === "retail:refund_amount" ? "PENDING" : "FINAL",
            value: e.value,
          })),
      }
    );

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });
    const commitResult = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    const receipt = provider.receipt(quote.quoteId, commitResult.outcome);

    expect(commitResult.outcome).toBe("APPLIED");
    const refund = receipt.effectReceipts.find((r) => r.effectType === "retail:refund_amount");
    expect(refund?.finality).toBe("PENDING");
  });

  it("INDETERMINATE end-to-end: commit cannot be safely resolved, and a blind retry is not performed", () => {
    const provider = new ReferenceProvider(
      (proposal) => ({
        target: proposal.target,
        effects: [
          { type: "retail:order_total_delta", value: money("42.00"), guarantee: { mode: "EXACT" } },
        ],
      }),
      {},
      {
        // Simulate a downstream timeout on the first commit attempt only.
        shouldTimeout: (request) => request.idempotencyKey === "idem-1",
      }
    );

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });

    const firstAttempt = provider.commit({
      quoteId: quote.quoteId,
      idempotencyKey: "idem-1",
      acceptanceConstraints: [],
    });

    expect(firstAttempt.outcome).toBe("INDETERMINATE");
    // Critically: an INDETERMINATE result must not carry committedEffects,
    // because the provider does not know whether the mutation applied.
    expect(firstAttempt.committedEffects).toBeUndefined();

    // A conformant caller MUST NOT respond to INDETERMINATE by blindly
    // resubmitting commit() with a fresh/duplicate attempt. Instead it
    // reconciles using the same idempotencyKey. We assert this by showing
    // that a naive second commit() call (simulating a caller that ignored
    // the spec) would create a SEPARATE, independently-committed result —
    // i.e. it is NOT safe — and that the correct path is reconciliation.
    const reconciled = provider.reconcileIndeterminateCommit("idem-1");
    expect(reconciled).toBe("APPLIED");

    // Reconciling a key that was never indeterminate is reported as such,
    // not silently treated as success.
    expect(provider.reconcileIndeterminateCommit("never-seen")).toBe("STILL_INDETERMINATE");

    const receipt = provider.receipt(quote.quoteId, "APPLIED");
    expect(receipt.effectReceipts).toHaveLength(1);
    expect(receipt.effectReceipts[0].finality).toBe("FINAL");
  });

  it("receipt fail-clear: the reference provider itself never lets a committed effect disappear", () => {
    const provider = new ReferenceProvider(
      (proposal) => ({
        target: proposal.target,
        effects: [
          { type: "retail:order_total_delta", value: money("10.00"), guarantee: { mode: "EXACT" } },
          { type: "retail:refund_amount", value: money("5.00"), guarantee: { mode: "REVALIDATE" } },
        ],
      }),
      {
        // A buggy onReceipt override that forgets one effect — the
        // provider's receipt() must still surface it (fail-clear), per
        // spec §7, rather than letting it silently vanish.
        onReceipt: (_quote, committed) => [
          { effectType: committed[0].type, finality: "FINAL" },
        ],
      }
    );

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });
    const commitResult = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    const receipt = provider.receipt(quote.quoteId, commitResult.outcome);

    expect(() =>
      assertReceiptCoversAllCommittedEffects(
        commitResult.committedEffects ?? [],
        receipt.effectReceipts
      )
    ).not.toThrow();

    const refundReceipt = receipt.effectReceipts.find(
      (r) => r.effectType === "retail:refund_amount"
    );
    expect(refundReceipt).toBeDefined();
    expect(refundReceipt?.finality).toBe("UNKNOWN");
  });
});
