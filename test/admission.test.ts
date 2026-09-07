import { describe, expect, it } from "vitest";
import { ReferenceProvider } from "../src/core/reference-provider";
import {
  assertAdmissionRefusalWellFormed,
  assertCommitResultCoversAllUnits,
  assertQuoteUnitsWellFormed,
  assertReconciliationContractHonored,
  MseViolation,
} from "../src/core/validate";
import type {
  AdmissionFailure,
  CommitResult,
  MutationProposal,
  MutationQuote,
  RequiredTransition,
} from "../src/core/types";
import {
  amendRetailProposal,
  createRetailAdmissionEvaluator,
  createRetailQuoter,
  isRetailProposalAuthorized,
  retailSnapshot,
  type RetailOrderState,
  type RetailTransition,
} from "../examples/retail/admission-policy";

function orderState(overrides: Partial<RetailOrderState["units"]> = {}): RetailOrderState {
  return {
    orderId: "order_799",
    version: 1,
    units: {
      goods_1: { kind: "GOODS", state: "ACTIVE" },
      goods_2: { kind: "GOODS", state: "ACTIVE" },
      delivery: { kind: "DELIVERY", state: "COMMITTED" },
      ...overrides,
    },
  };
}

function proposal(proposalId: string, transitions: RetailTransition[]): MutationProposal {
  return {
    proposalId,
    target: { orderId: "order_799" },
    change: { transitions },
  };
}

function commitResult(response: ReturnType<ReferenceProvider["commit"]>): CommitResult {
  expect(response.kind).toBe("COMMIT_RESULT");
  if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
  return response.commitResult;
}

function admissionFailures(
  response: ReturnType<ReferenceProvider["commit"]>
): AdmissionFailure[] {
  expect(response.kind).toBe("ADMISSION_REFUSED");
  if (response.kind !== "ADMISSION_REFUSED") throw new Error("Expected ADMISSION_REFUSED");
  return response.admissionRefusal.failures;
}

function configuredProvider(
  current: { value: RetailOrderState },
  admission = createRetailAdmissionEvaluator((orderId) => {
    expect(orderId).toBe(current.value.orderId);
    return current.value;
  }),
  fault: ConstructorParameters<typeof ReferenceProvider>[2] = {}
) {
  let dispatchCount = 0;
  const readState = (orderId: string) => {
    expect(orderId).toBe(current.value.orderId);
    return current.value;
  };
  const provider = new ReferenceProvider(
    createRetailQuoter(readState),
    {
      onCommit: (_quote, unit) => {
        dispatchCount += 1;
        return unit.effects.map((effect) => ({ ...effect }));
      },
    },
    fault,
    admission
  );
  const syncSnapshot = () =>
    provider.setSnapshot({ orderId: current.value.orderId }, retailSnapshot(current.value));
  return { provider, syncSnapshot, dispatchCount: () => dispatchCount };
}

describe("retail cross-unit admission — provider-reported UCP #799 gates", () => {
  it("returns both missing active-goods cancellations and dispatches nothing", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot, dispatchCount } = configuredProvider(current);
    const submitted = proposal("cancel-1", [{ unitKey: "delivery", operation: "CANCEL" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();

    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    const failures = admissionFailures(response);
    const witness = failures[0].witness;
    expect(witness.disposition).toBe("COMPLETE");
    if (witness.disposition !== "COMPLETE") throw new Error("Expected COMPLETE witness");
    expect(witness.requiredTransitions.map((item) => item.unitLocator.unitKey)).toEqual([
      "goods_1",
      "goods_2",
    ]);
    expect(response).not.toHaveProperty("commitResult");
    expect(quote.units.map((unit) => unit.unitLocator.unitKey)).toEqual(["delivery"]);
    expect(dispatchCount()).toBe(0);
    if (response.kind === "ADMISSION_REFUSED") {
      expect(response.admissionRefusal.quoteId).toBe(quote.quoteId);
      expect(response.admissionRefusal.proposalId).toBe(submitted.proposalId);
      expect(response.admissionRefusal.stateRef).toEqual({ orderVersion: 1 });
      expect(() =>
        assertAdmissionRefusalWellFormed(quote, submitted, response.admissionRefusal)
      ).not.toThrow();
    }
  });

  it("excludes an already-cancelled goods unit from the complete witness", () => {
    const current = {
      value: orderState({ goods_1: { kind: "GOODS", state: "CANCELLED" } }),
    };
    const { provider, syncSnapshot } = configuredProvider(current);
    const quote = provider.quote(
      proposal("cancel-2", [{ unitKey: "delivery", operation: "CANCEL" }])
    );
    syncSnapshot();

    const witness = admissionFailures(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    )[0].witness;
    expect(witness.disposition).toBe("COMPLETE");
    if (witness.disposition === "COMPLETE") {
      expect(witness.requiredTransitions.map((item) => item.unitLocator.unitKey)).toEqual([
        "goods_2",
      ]);
    }
  });

  it("excludes a required cancellation already included in the proposal", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const quote = provider.quote(
      proposal("cancel-3", [
        { unitKey: "delivery", operation: "CANCEL" },
        { unitKey: "goods_1", operation: "CANCEL" },
      ])
    );
    syncSnapshot();

    const witness = admissionFailures(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    )[0].witness;
    expect(witness.disposition).toBe("COMPLETE");
    if (witness.disposition === "COMPLETE") {
      expect(witness.requiredTransitions.map((item) => item.unitLocator.unitKey)).toEqual([
        "goods_2",
      ]);
    }
  });

  it("passes the cancellation relation when every active goods cancellation is included", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot, dispatchCount } = configuredProvider(current);
    const quote = provider.quote(
      proposal("cancel-4", [
        { unitKey: "delivery", operation: "CANCEL" },
        { unitKey: "goods_1", operation: "CANCEL" },
        { unitKey: "goods_2", operation: "CANCEL" },
      ])
    );
    syncSnapshot();

    const result = commitResult(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    );
    expect(result.unitResults.every((unit) => unit.outcome === "APPLIED")).toBe(true);
    expect(dispatchCount()).toBe(3);
  });

  it("requires delivery redemption while delivery remains committed", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const quote = provider.quote(
      proposal("redeem-1", [{ unitKey: "goods_1", operation: "REDEEM" }])
    );
    syncSnapshot();

    const witness = admissionFailures(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    )[0].witness;
    expect(witness).toEqual({
      disposition: "COMPLETE",
      requiredTransitions: [
        {
          unitLocator: { scopeRef: "retail:order_799", unitKey: "delivery" },
          transition: { unitKey: "delivery", operation: "REDEEM" },
        },
      ],
    });
  });

  it("does not fire the redemption relation after delivery leaves committed state", () => {
    const current = {
      value: orderState({ delivery: { kind: "DELIVERY", state: "REDEEMED" } }),
    };
    const { provider, syncSnapshot } = configuredProvider(current);
    const quote = provider.quote(
      proposal("redeem-2", [{ unitKey: "goods_1", operation: "REDEEM" }])
    );
    syncSnapshot();

    const result = commitResult(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    );
    expect(result.unitResults[0].outcome).toBe("APPLIED");
  });
});

describe("admission witness honesty and scope", () => {
  const relationQuote = (): MutationQuote => ({
    quoteId: "relation-quote",
    target: {},
    units: [
      {
        unitRef: "unit-1",
        unitLocator: { scopeRef: "scope-1", unitKey: "key-1" },
        transition: {},
        effects: [],
      },
    ],
    admissionRelations: [
      {
        relationId: "relation-1",
        type: "REQUIRES_COINCLUSION",
        triggerUnitRefs: ["unit-1"],
        scopeRef: "scope-1",
      },
    ],
  });

  it("rejects a quote relation with an unknown trigger unit", () => {
    const quote = relationQuote();
    quote.admissionRelations[0].triggerUnitRefs = ["not-quoted"];
    expect(() => assertQuoteUnitsWellFormed(quote)).toThrow(MseViolation);
  });

  it("rejects a quote relation whose trigger belongs to a different scope", () => {
    const quote = relationQuote();
    quote.admissionRelations[0].scopeRef = "another-scope";
    expect(() => assertQuoteUnitsWellFormed(quote)).toThrow(MseViolation);
  });

  it("rejects duplicate binding-scoped unit locators within a quote", () => {
    const quote = relationQuote();
    quote.units.push({ ...quote.units[0], unitRef: "unit-2" });
    expect(() => assertQuoteUnitsWellFormed(quote)).toThrow(MseViolation);
  });

  it("rejects contradictory transitions for one retail unit at the binding boundary", () => {
    const current = { value: orderState() };
    const { provider } = configuredProvider(current);
    expect(() =>
      provider.quote(
        proposal("contradictory", [
          { unitKey: "delivery", operation: "CANCEL" },
          { unitKey: "delivery", operation: "REDEEM" },
        ])
      )
    ).toThrow(/duplicate or contradictory/);
  });

  it("fails closed without inventing a failure when no evaluator exists", () => {
    const state = orderState();
    const provider = new ReferenceProvider(createRetailQuoter(() => state));
    const quote = provider.quote(
      proposal("no-evaluator", [{ unitKey: "delivery", operation: "CANCEL" }])
    );
    provider.setSnapshot(quote.target, retailSnapshot(state));
    expect(() => provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] }))
      .toThrow(/require an evaluator/);
  });

  it("preserves PARTIAL as insufficient rather than advertising local repair", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot, dispatchCount } = configuredProvider(current, () => ({
      stateRef: { orderVersion: 1 },
      coverage: [{ relationId: "retail:delivery_cancel_requires_goods_cancel", status: "FAILED" }],
      failures: [
        {
          relationId: "retail:delivery_cancel_requires_goods_cancel",
          witness: {
            disposition: "PARTIAL",
            requiredTransitions: [
              {
                unitLocator: { scopeRef: "retail:order_799", unitKey: "goods_1" },
                transition: { unitKey: "goods_1", operation: "CANCEL" },
              },
            ],
          },
        },
      ],
    }));
    const quote = provider.quote(
      proposal("partial", [{ unitKey: "delivery", operation: "CANCEL" }])
    );
    syncSnapshot();
    const witness = admissionFailures(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    )[0].witness;
    expect(witness.disposition).toBe("PARTIAL");
    expect(dispatchCount()).toBe(0);
  });

  it("rejects a missing/malformed witness before dispatch", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot, dispatchCount } = configuredProvider(
      current,
      () => ({
        coverage: [{ relationId: "retail:delivery_cancel_requires_goods_cancel", status: "FAILED" }],
        failures: [
          {
            relationId: "retail:delivery_cancel_requires_goods_cancel",
          } as unknown as AdmissionFailure,
        ],
      })
    );
    const quote = provider.quote(
      proposal("malformed", [{ unitKey: "delivery", operation: "CANCEL" }])
    );
    syncSnapshot();
    expect(() => provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })).toThrow(
      MseViolation
    );
    expect(dispatchCount()).toBe(0);
  });

  it.each([
    [
      "duplicate locator",
      [
        {
          unitLocator: { scopeRef: "retail:order_799", unitKey: "goods_1" },
          transition: { unitKey: "goods_1", operation: "CANCEL" },
        },
        {
          unitLocator: { scopeRef: "retail:order_799", unitKey: "goods_1" },
          transition: { unitKey: "goods_1", operation: "REDEEM" },
        },
      ],
    ],
    [
      "wrong scope",
      [
        {
          unitLocator: { scopeRef: "retail:another_order", unitKey: "goods_1" },
          transition: { unitKey: "goods_1", operation: "CANCEL" },
        },
      ],
    ],
    [
      "unit already present",
      [
        {
          unitLocator: { scopeRef: "retail:order_799", unitKey: "delivery" },
          transition: { unitKey: "delivery", operation: "REDEEM" },
        },
      ],
    ],
  ] as const)("rejects a COMPLETE witness with %s", (_label, requirements) => {
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current, () => ({
      coverage: [{ relationId: "retail:delivery_cancel_requires_goods_cancel", status: "FAILED" }],
      failures: [
        {
          relationId: "retail:delivery_cancel_requires_goods_cancel",
          witness: {
            disposition: "COMPLETE",
            requiredTransitions: requirements as unknown as RequiredTransition[],
          },
        },
      ],
    }));
    const quote = provider.quote(
      proposal("bad-complete", [{ unitKey: "delivery", operation: "CANCEL" }])
    );
    syncSnapshot();
    expect(() => provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })).toThrow(
      MseViolation
    );
  });

  it("rejects an unresolvable repair reference at the retail binding boundary", () => {
    const original = proposal("unresolvable-1", [
      { unitKey: "delivery", operation: "CANCEL" },
    ]);
    expect(() =>
      amendRetailProposal(
        original,
        [
          {
            unitLocator: { scopeRef: "retail:order_799", unitKey: "not_in_order" },
            transition: { unitKey: "not_in_order", operation: "CANCEL" },
          },
        ],
        orderState(),
        "unresolvable-2"
      )
    ).toThrow(/unresolvable/);
  });
});

describe("repair lifecycle, safety checks, and non-atomic execution", () => {
  it("re-evaluates after a structurally valid but semantically incomplete COMPLETE witness", () => {
    const current = { value: orderState() };
    const liveEvaluator = createRetailAdmissionEvaluator(() => current.value);
    let evaluationCount = 0;
    const { provider, syncSnapshot, dispatchCount } = configuredProvider(
      current,
      (submitted, quote, now) => {
        evaluationCount += 1;
        if (evaluationCount === 1) {
          // Core can validate this shape, but only the retail binding can know
          // that goods_2 was dishonestly omitted from the COMPLETE list.
          return {
            stateRef: { orderVersion: current.value.version },
            coverage: [{ relationId: "retail:delivery_cancel_requires_goods_cancel", status: "FAILED" }],
            failures: [
              {
                relationId: "retail:delivery_cancel_requires_goods_cancel",
                witness: {
                  disposition: "COMPLETE",
                  requiredTransitions: [
                    {
                      unitLocator: {
                        scopeRef: "retail:order_799",
                        unitKey: "goods_1",
                      },
                      transition: { unitKey: "goods_1", operation: "CANCEL" },
                    },
                  ],
                },
              },
            ],
          };
        }
        return liveEvaluator(submitted, quote, now);
      }
    );

    const original = proposal("false-complete-1", [
      { unitKey: "delivery", operation: "CANCEL" },
    ]);
    const firstQuote = provider.quote(original);
    syncSnapshot();
    const firstWitness = admissionFailures(
      provider.commit({ quoteId: firstQuote.quoteId, acceptanceConstraints: [] })
    )[0].witness;
    if (firstWitness.disposition !== "COMPLETE") throw new Error("Expected COMPLETE witness");

    const amended = amendRetailProposal(
      original,
      firstWitness.requiredTransitions,
      current.value,
      "false-complete-2"
    );
    const secondQuote = provider.quote(amended);
    syncSnapshot();
    const secondWitness = admissionFailures(
      provider.commit({ quoteId: secondQuote.quoteId, acceptanceConstraints: [] })
    )[0].witness;

    expect(secondWitness.disposition).toBe("COMPLETE");
    if (secondWitness.disposition === "COMPLETE") {
      expect(secondWitness.requiredTransitions.map((item) => item.unitLocator.unitKey)).toEqual([
        "goods_2",
      ]);
    }
    expect(evaluationCount).toBe(2);
    expect(dispatchCount()).toBe(0);
  });

  it("requires a new quote and freshly discovers state added after the first witness", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot, dispatchCount } = configuredProvider(current);
    const original = proposal("repair-1", [{ unitKey: "delivery", operation: "CANCEL" }]);
    const firstQuote = provider.quote(original);
    syncSnapshot();
    const firstResponse = provider.commit({ quoteId: firstQuote.quoteId, acceptanceConstraints: [] });
    const firstWitness = admissionFailures(firstResponse)[0].witness;
    if (firstWitness.disposition !== "COMPLETE") throw new Error("Expected COMPLETE witness");

    const amended = amendRetailProposal(
      original,
      firstWitness.requiredTransitions,
      current.value,
      "repair-2"
    );
    current.value = {
      ...current.value,
      version: 2,
      units: {
        ...current.value.units,
        goods_3: { kind: "GOODS", state: "ACTIVE" },
      },
    };
    const secondQuote = provider.quote(amended);
    syncSnapshot();
    const secondWitness = admissionFailures(
      provider.commit({ quoteId: secondQuote.quoteId, acceptanceConstraints: [] })
    )[0].witness;

    expect(secondQuote.quoteId).not.toBe(firstQuote.quoteId);
    expect(secondQuote.units[0].unitRef).not.toBe(firstQuote.units[0].unitRef);
    expect(secondQuote.units[0].unitLocator).toEqual(firstQuote.units[0].unitLocator);
    expect(secondWitness.disposition).toBe("COMPLETE");
    if (secondWitness.disposition === "COMPLETE") {
      expect(secondWitness.requiredTransitions.map((item) => item.unitLocator.unitKey)).toEqual([
        "goods_3",
      ]);
    }
    expect(dispatchCount()).toBe(0);
  });

  it("does not treat a witness as authorization for an added unit", () => {
    const original = proposal("auth-1", [{ unitKey: "delivery", operation: "CANCEL" }]);
    const required: RequiredTransition[] = [
      {
        unitLocator: { scopeRef: "retail:order_799", unitKey: "goods_1" },
        transition: { unitKey: "goods_1", operation: "CANCEL" },
      },
    ];
    const amended = amendRetailProposal(original, required, orderState(), "auth-2");
    expect(isRetailProposalAuthorized(amended, new Set(["delivery"]))).toBe(false);
  });

  it("keeps quote expiry effective after an otherwise valid repair", () => {
    const current = { value: orderState() };
    let dispatchCount = 0;
    const retailQuoter = createRetailQuoter(() => current.value);
    const provider = new ReferenceProvider(
      (p) => ({ ...retailQuoter(p), expiresAt: "2020-01-01T00:00:00Z" }),
      {
        onCommit: (_quote, unit) => {
          dispatchCount += 1;
          return unit.effects;
        },
      },
      {},
      createRetailAdmissionEvaluator(() => current.value)
    );
    const quote = provider.quote(
      proposal("expired", [
        { unitKey: "delivery", operation: "CANCEL" },
        { unitKey: "goods_1", operation: "CANCEL" },
        { unitKey: "goods_2", operation: "CANCEL" },
      ])
    );
    provider.setSnapshot(quote.target, retailSnapshot(current.value));
    const result = commitResult(
      provider.commit(
        { quoteId: quote.quoteId, acceptanceConstraints: [] },
        new Date("2021-01-01T00:00:00Z")
      )
    );
    expect(result.unitResults.every((item) => item.refusalReason === "QUOTE_EXPIRED")).toBe(true);
    expect(dispatchCount).toBe(0);
  });

  it("keeps SNAPSHOT_REQUIRED effective when state changes after quote", () => {
    const current = { value: orderState() };
    const { provider, dispatchCount } = configuredProvider(current);
    const quote = provider.quote(
      proposal("snapshot", [
        { unitKey: "delivery", operation: "CANCEL" },
        { unitKey: "goods_1", operation: "CANCEL" },
        { unitKey: "goods_2", operation: "CANCEL" },
      ])
    );
    current.value = { ...current.value, version: 2 };
    provider.setSnapshot(quote.target, retailSnapshot(current.value));
    const result = commitResult(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    );
    expect(result.unitResults.every((item) => item.refusalReason === "SNAPSHOT_MISMATCH")).toBe(
      true
    );
    expect(dispatchCount()).toBe(0);
  });

  it("keeps acceptance constraints effective after admission passes", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const quote = provider.quote(
      proposal("constraint", [
        { unitKey: "goods_1", operation: "REDEEM" },
        { unitKey: "delivery", operation: "REDEEM" },
      ])
    );
    syncSnapshot();
    const delivery = quote.units.find((unit) => unit.unitLocator.unitKey === "delivery")!;
    const result = commitResult(
      provider.commit({
        quoteId: quote.quoteId,
        acceptanceConstraints: [
          {
            effectId: delivery.effects[0].effectId,
            operator: "<=",
            value: { type: "money", amount: "-1.00", currency: "USD" },
          },
        ],
      })
    );
    expect(result.unitResults.find((item) => item.unitRef === delivery.unitRef)?.outcome).toBe(
      "REFUSED"
    );
    expect(result.unitResults.some((item) => item.outcome === "APPLIED")).toBe(true);
  });

  it("preserves per-unit INDETERMINATE and reconciliation after admission passes", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(
      current,
      createRetailAdmissionEvaluator(() => current.value),
      {
        shouldTimeout: (_request, _quote, unit) => unit.unitLocator.unitKey === "delivery",
        reconciliationOutcome: () => "REFUSED",
      }
    );
    const quote = provider.quote(
      proposal("indeterminate", [
        { unitKey: "goods_1", operation: "REDEEM" },
        { unitKey: "delivery", operation: "REDEEM" },
      ])
    );
    syncSnapshot();
    const result = commitResult(
      provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })
    );
    expect(() => assertCommitResultCoversAllUnits(quote, result)).not.toThrow();
    const delivery = quote.units.find((unit) => unit.unitLocator.unitKey === "delivery")!;
    const deliveryResult = result.unitResults.find((item) => item.unitRef === delivery.unitRef)!;
    expect(deliveryResult.outcome).toBe("INDETERMINATE");
    expect(() => assertReconciliationContractHonored(deliveryResult)).not.toThrow();
    expect(result.aggregateHint).toBe("MIXED");
    expect(provider.reconcile(deliveryResult.reconciliation!.correlationId!)).toBe("REFUSED");
  });
});
