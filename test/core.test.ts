import { describe, it, expect } from "vitest";
import {
  evaluateAcceptanceConstraints,
  isQuoteExpired,
  assertExactGuaranteesHonored,
  MseViolation,
} from "../src/core/validate";
import { ReferenceProvider } from "../src/core/reference-provider";
import type {
  MutationQuote,
  AcceptanceConstraint,
  CommitResult,
} from "../src/core/types";

function baseQuote(overrides: Partial<MutationQuote> = {}): MutationQuote {
  return {
    quoteId: "q1",
    target: { orderId: "order_1" },
    effects: [
      {
        type: "retail:order_total_delta",
        value: 42,
        guarantee: { mode: "EXACT" },
      },
    ],
    ...overrides,
  };
}

describe("evaluateAcceptanceConstraints", () => {
  it("passes when the constraint is satisfied", () => {
    const quote = baseQuote();
    const constraints: AcceptanceConstraint[] = [
      { effectType: "retail:order_total_delta", operator: "<=", value: 100 },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toEqual([]);
  });

  it("fails closed when the effect is missing from the quote", () => {
    const quote = baseQuote();
    const constraints: AcceptanceConstraint[] = [
      { effectType: "retail:nonexistent", operator: "<=", value: 100 },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toHaveLength(1);
  });

  it("fails closed when the effect's guarantee is UNKNOWN", () => {
    const quote = baseQuote({
      effects: [
        {
          type: "retail:order_total_delta",
          value: 42,
          guarantee: { mode: "UNKNOWN" },
        },
      ],
    });
    const constraints: AcceptanceConstraint[] = [
      { effectType: "retail:order_total_delta", operator: "<=", value: 100 },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toHaveLength(1);
  });

  it("fails when the bound is violated", () => {
    const quote = baseQuote();
    const constraints: AcceptanceConstraint[] = [
      { effectType: "retail:order_total_delta", operator: "<=", value: 10 },
    ];
    expect(evaluateAcceptanceConstraints(quote, constraints)).toHaveLength(1);
  });

  it("treats a type mismatch between effect.value and constraint.value as a violation", () => {
    const quote = baseQuote({
      effects: [
        {
          type: "retail:order_total_delta",
          value: "not-a-number",
          guarantee: { mode: "EXACT" },
        },
      ],
    });
    const constraints: AcceptanceConstraint[] = [
      { effectType: "retail:order_total_delta", operator: "<=", value: 100 },
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
        { type: "retail:order_total_delta", value: 42, guarantee: { mode: "EXACT" } },
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
        { type: "retail:order_total_delta", value: 43, guarantee: { mode: "EXACT" } },
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

describe("ReferenceProvider — full lifecycle", () => {
  it("APPLIED path: proposal -> quote -> commit -> receipt", () => {
    const provider = new ReferenceProvider((proposal) => ({
      target: proposal.target,
      effects: [
        { type: "retail:order_total_delta", value: 42, guarantee: { mode: "EXACT" } },
      ],
    }));

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });
    const commitResult = provider.commit({
      quoteId: quote.quoteId,
      acceptanceConstraints: [
        { effectType: "retail:order_total_delta", operator: "<=", value: 100 },
      ],
    });

    expect(commitResult.outcome).toBe("APPLIED");
    expect(() => assertExactGuaranteesHonored(quote, commitResult)).not.toThrow();

    const receipt = provider.receipt(quote.quoteId, commitResult.outcome);
    expect(receipt.effectReceipts[0].finality).toBe("FINAL");
  });

  it("REFUSED path: acceptance constraint violated", () => {
    const provider = new ReferenceProvider((proposal) => ({
      target: proposal.target,
      effects: [
        { type: "retail:order_total_delta", value: 999, guarantee: { mode: "EXACT" } },
      ],
    }));

    const quote = provider.quote({ proposalId: "p1", target: { orderId: "o1" }, change: {} });
    const commitResult = provider.commit({
      quoteId: quote.quoteId,
      acceptanceConstraints: [
        { effectType: "retail:order_total_delta", operator: "<=", value: 100 },
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

  it("distinguishes mutation APPLIED from a PENDING downstream effect", () => {
    const provider = new ReferenceProvider(
      (proposal) => ({
        target: proposal.target,
        effects: [
          { type: "retail:order_total_delta", value: -20, guarantee: { mode: "EXACT" } },
          { type: "retail:refund_amount", value: 20, guarantee: { mode: "REVALIDATE" } },
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
});
