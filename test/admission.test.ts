import { describe, expect, it } from "vitest";
import { ReferenceProvider } from "../src/core/reference-provider";
import {
  assertAdmissionCoverageWellFormed,
  assertAdmissionRefusalWellFormed,
  assertAdmissionReportWellFormed,
  assertCommitResponseWellFormed,
  assertCommitResultCoversAllUnits,
  assertQuoteUnitsWellFormed,
  assertReconciliationContractHonored,
  MseViolation,
} from "../src/core/validate";
import type {
  AdmissionFailure,
  AdmissionReport,
  CommitResult,
  MutationProposal,
  MutationQuote,
  RequiredTransition,
} from "../src/core/types";
import {
  amendRetailProposal,
  assertRetailAdmissionTrace,
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
      value: orderState({
        goods_1: {
          kind: "GOODS",
          state: "CANCELLED",
          transitionHistory: [{
            status: "FINAL",
            transitionRef: "cancel-goods-1",
            transition: { unitKey: "goods_1", operation: "CANCEL" },
            finalizedAt: "2026-09-01T10:00:00Z",
          }],
        },
      }),
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

  it("passes redemption from a prior final delivery redemption", () => {
    const current = {
      value: orderState({
        delivery: {
          kind: "DELIVERY",
          state: "REDEEMED",
          transitionHistory: [{
            status: "FINAL",
            transitionRef: "redeem-delivery-1",
            transition: { unitKey: "delivery", operation: "REDEEM" },
            finalizedAt: "2026-09-01T11:00:00Z",
          }],
        },
      }),
    };
    const { provider, syncSnapshot } = configuredProvider(current);
    const quote = provider.quote(
      proposal("redeem-2", [{ unitKey: "goods_1", operation: "REDEEM" }])
    );
    syncSnapshot();

    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    const result = commitResult(response);
    expect(result.unitResults[0].outcome).toBe("APPLIED");
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    expect(response.admissionReport.coverage[0]).toMatchObject({
      status: "PASSED",
      satisfactions: [{
        source: "PRIOR_FINAL_TRANSITION",
        transitionRef: "redeem-delivery-1",
      }],
    });
  });
});

describe("wire-visible retail pass satisfaction", () => {
  const finalTransition = (unitKey: string, operation: "CANCEL" | "REDEEM", ref: string) => ({
    status: "FINAL" as const,
    transitionRef: ref,
    transition: { unitKey, operation },
    finalizedAt: "2026-09-01T12:00:00Z",
  });

  function admitted(current: { value: RetailOrderState }, submitted: MutationProposal) {
    const { provider, syncSnapshot } = configuredProvider(current);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] },
      new Date("2026-09-02T00:00:00Z")
    );
    expect(response.kind).toBe("COMMIT_RESULT");
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    expect(() => assertAdmissionReportWellFormed(quote, submitted, response.admissionReport))
      .not.toThrow();
    expect(() => assertCommitResponseWellFormed(quote, submitted, response)).not.toThrow();
    return { quote, response };
  }

  it("reports delivery cancellation satisfied entirely by current-request goods cancellations", () => {
    const current = { value: orderState() };
    const submitted = proposal("current-cancel", [
      { unitKey: "delivery", operation: "CANCEL" },
      { unitKey: "goods_1", operation: "CANCEL" },
      { unitKey: "goods_2", operation: "CANCEL" },
    ]);
    const { quote, response } = admitted(current, submitted);
    const passed = response.admissionReport.coverage[0];
    expect(passed.status).toBe("PASSED");
    if (passed.status !== "PASSED") throw new Error("Expected PASSED");
    expect(passed.satisfactions?.map(item => item.source)).toEqual([
      "CURRENT_REQUEST", "CURRENT_REQUEST",
    ]);
    const reordered = structuredClone(response.admissionReport);
    const reorderedPassed = reordered.coverage[0];
    if (reorderedPassed.status !== "PASSED" || !reorderedPassed.satisfactions) {
      throw new Error("Expected satisfaction evidence");
    }
    reorderedPassed.satisfactions.reverse();
    expect(() => assertRetailAdmissionTrace(submitted, quote, reordered, current.value)).not.toThrow();
  });

  it("reports delivery cancellation satisfied entirely by prior final goods cancellations", () => {
    const current = { value: orderState({
      goods_1: {
        kind: "GOODS", state: "CANCELLED",
        transitionHistory: [finalTransition("goods_1", "CANCEL", "prior-cancel-1")],
      },
      goods_2: {
        kind: "GOODS", state: "CANCELLED",
        transitionHistory: [finalTransition("goods_2", "CANCEL", "prior-cancel-2")],
      },
    }) };
    const submitted = proposal("prior-cancel", [{ unitKey: "delivery", operation: "CANCEL" }]);
    const { response } = admitted(current, submitted);
    const passed = response.admissionReport.coverage[0];
    if (passed.status !== "PASSED") throw new Error("Expected PASSED");
    expect(passed.satisfactions?.map(item => item.source)).toEqual([
      "PRIOR_FINAL_TRANSITION", "PRIOR_FINAL_TRANSITION",
    ]);
  });

  it("reports mixed current-request and prior-final cancellation satisfaction", () => {
    const current = { value: orderState({
      goods_2: {
        kind: "GOODS", state: "CANCELLED",
        transitionHistory: [finalTransition("goods_2", "CANCEL", "prior-cancel-2")],
      },
    }) };
    const submitted = proposal("mixed-cancel", [
      { unitKey: "delivery", operation: "CANCEL" },
      { unitKey: "goods_1", operation: "CANCEL" },
    ]);
    const { response } = admitted(current, submitted);
    const passed = response.admissionReport.coverage[0];
    if (passed.status !== "PASSED") throw new Error("Expected PASSED");
    expect(new Set(passed.satisfactions?.map(item => item.source))).toEqual(new Set([
      "CURRENT_REQUEST", "PRIOR_FINAL_TRANSITION",
    ]));
  });

  it("reports delivery redemption in the current request as goods-redemption satisfaction", () => {
    const current = { value: orderState() };
    const submitted = proposal("current-redeem", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const { response } = admitted(current, submitted);
    expect(response.admissionReport.coverage[0]).toMatchObject({
      status: "PASSED",
      satisfactions: [{ source: "CURRENT_REQUEST" }],
    });
  });

  it.each(["SUBMITTED", "PENDING", "FAILED"] as const)(
    "does not accept a prior %s delivery redemption as final",
    (status) => {
      const current = { value: orderState({
        delivery: {
          kind: "DELIVERY",
          state: status === "FAILED" ? "COMMITTED" : "REDEEMED",
          transitionHistory: [{
            status,
            transitionRef: `redeem-${status.toLowerCase()}`,
            transition: { unitKey: "delivery", operation: "REDEEM" },
          }],
        },
      }) };
      const { provider, syncSnapshot } = configuredProvider(current);
      const quote = provider.quote(proposal(`nonfinal-${status}`, [
        { unitKey: "goods_1", operation: "REDEEM" },
      ]));
      syncSnapshot();
      expect(provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] }).kind)
        .toBe("ADMISSION_REFUSED");
    }
  );

  it("rejects duplicate and malformed prior-final satisfaction structurally", () => {
    const current = { value: orderState({
      delivery: {
        kind: "DELIVERY", state: "REDEEMED",
        transitionHistory: [finalTransition("delivery", "REDEEM", "prior-redeem")],
      },
    }) };
    const submitted = proposal("bad-evidence", [{ unitKey: "goods_1", operation: "REDEEM" }]);
    const { quote, response } = admitted(current, submitted);
    const duplicate = structuredClone(response.admissionReport.coverage);
    const entry = duplicate[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    entry.satisfactions.push(structuredClone(entry.satisfactions[0]));
    expect(() => assertAdmissionCoverageWellFormed(quote, [], duplicate)).toThrow(/Duplicate/);

    const missing = structuredClone(response.admissionReport.coverage) as unknown as Array<Record<string, unknown>>;
    const satisfaction = (missing[0].satisfactions as Array<Record<string, unknown>>)[0];
    delete satisfaction.transitionRef;
    expect(() => assertAdmissionCoverageWellFormed(
      quote, [], missing as unknown as AdmissionReport["coverage"]
    )).toThrow(/transitionRef/);

    const unrelated = structuredClone(response.admissionReport.coverage);
    const unrelatedEntry = unrelated[0];
    if (unrelatedEntry.status !== "PASSED" ||
        unrelatedEntry.satisfactions?.[0].source !== "PRIOR_FINAL_TRANSITION") {
      throw new Error("Expected prior evidence");
    }
    unrelatedEntry.satisfactions[0].unitLocator.scopeRef = "retail:another_order";
    expect(() => assertAdmissionCoverageWellFormed(quote, [], unrelated)).toThrow(/unrelated/);
  });

  it("leaves semantic lies to retail trace conformance, including wrong unit or transition", () => {
    const current = { value: orderState({
      delivery: {
        kind: "DELIVERY", state: "REDEEMED",
        transitionHistory: [finalTransition("delivery", "REDEEM", "prior-redeem")],
      },
    }) };
    const submitted = proposal("trace-evidence", [{ unitKey: "goods_1", operation: "REDEEM" }]);
    const { quote, response } = admitted(current, submitted);
    const wrongUnit = structuredClone(response.admissionReport);
    const evidence = wrongUnit.coverage[0];
    if (evidence.status !== "PASSED" || evidence.satisfactions?.[0].source !== "PRIOR_FINAL_TRANSITION") {
      throw new Error("Expected prior evidence");
    }
    evidence.satisfactions[0].unitLocator.unitKey = "goods_2";
    expect(() => assertAdmissionReportWellFormed(quote, submitted, wrongUnit)).not.toThrow();
    expect(() => assertRetailAdmissionTrace(submitted, quote, wrongUnit, current.value)).toThrow();

    const wrongTransition = structuredClone(response.admissionReport);
    const wrong = wrongTransition.coverage[0];
    if (wrong.status !== "PASSED" || wrong.satisfactions?.[0].source !== "PRIOR_FINAL_TRANSITION") {
      throw new Error("Expected prior evidence");
    }
    wrong.satisfactions[0].transition = { unitKey: "delivery", operation: "CANCEL" };
    expect(() => assertAdmissionReportWellFormed(quote, submitted, wrongTransition)).not.toThrow();
    expect(() => assertRetailAdmissionTrace(submitted, quote, wrongTransition, current.value)).toThrow();
  });

  it("fails closed when a provider labels required unevaluated coverage PASSED", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot, dispatchCount } = configuredProvider(current, () => ({
      failures: [],
      coverage: [{
        relationId: "retail:goods_redeem_requires_delivery_redeem",
        status: "PASSED",
      }],
    }));
    const quote = provider.quote(proposal("omitted-evaluation", [
      { unitKey: "goods_1", operation: "REDEEM" },
    ]));
    syncSnapshot();
    expect(() => provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] }))
      .toThrow(/requires satisfaction evidence/);
    expect(dispatchCount()).toBe(0);
  });

  it("runtime validation rejects a successful response with an omitted report", () => {
    const current = { value: orderState() };
    const submitted = proposal("runtime-omit", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const { quote, response } = admitted(current, submitted);
    const malformed = structuredClone(response) as unknown as Record<string, unknown>;
    delete malformed.admissionReport;
    expect(() => assertCommitResponseWellFormed(
      quote, submitted, malformed as unknown as ReturnType<ReferenceProvider["commit"]>
    )).toThrow(/requires an admissionReport/);
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
