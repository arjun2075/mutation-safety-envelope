import { describe, expect, it } from "vitest";
import { ReferenceProvider } from "../src/core/reference-provider";
import {
  assertAdmissionCoverageWellFormed,
  assertSatisfactionRealizationConsistent,
  deriveSatisfactionRealization,
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
    // Behavior change in this revision: because the entry now states the
    // required participant set, core validation catches a cited participant
    // outside it rather than deferring the whole class to trace conformance.
    // The boundary itself is unchanged and is still exercised by the
    // wrong-transition case below, which core cannot detect.
    expect(() => assertAdmissionReportWellFormed(quote, submitted, wrongUnit)).toThrow(
      /outside the required participant set/
    );
    expect(() => assertRetailAdmissionTrace(submitted, quote, wrongUnit, current.value)).toThrow();

    // A wrong unit that IS inside the required set remains a semantic lie
    // core cannot detect: only the binding can re-read the real history.
    const swappedRequirement = structuredClone(response.admissionReport);
    const swapped = swappedRequirement.coverage[0];
    if (swapped.status !== "PASSED" || swapped.satisfactions?.[0].source !== "PRIOR_FINAL_TRANSITION") {
      throw new Error("Expected prior evidence");
    }
    swapped.satisfactions[0].unitLocator.unitKey = "goods_2";
    swapped.requiredParticipants = [
      {
        unitLocator: { scopeRef: "retail:order_799", unitKey: "goods_2" },
        transition: { unitKey: "delivery", operation: "REDEEM" },
      },
    ];
    expect(() => assertAdmissionReportWellFormed(quote, submitted, swappedRequirement)).not.toThrow();
    expect(() =>
      assertRetailAdmissionTrace(submitted, quote, swappedRequirement, current.value)
    ).toThrow();

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

/**
 * Regression vectors for the UCP #799 follow-up review: execution-time
 * realization of CURRENT_REQUEST evidence, satisfaction-evidence
 * completeness, and temporal consistency of prior-final evidence.
 *
 * These do not introduce a lifecycle state, an atomicity guarantee, or an
 * ordering requirement. In particular, no case here requires a dependent
 * unit to wait for its satisfier to become APPLIED: REQUIRES_COINCLUSION
 * remains non-atomic (spec §1d).
 */
describe("execution-time realization of current-request satisfaction", () => {
  /**
   * The production-style counterexample: the request redeems goods_1 and
   * delivery, admission passes, and a caller acceptance constraint
   * deliberately refuses the delivery unit while goods_1 is APPLIED. The
   * PASSED record then cites a transition the same response reports REFUSED.
   */
  function refusedSatisfierResponse(
    faultOnDelivery: "REFUSED" | "INDETERMINATE" | "APPLIED"
  ) {
    const current = { value: orderState() };
    const fault =
      faultOnDelivery === "INDETERMINATE"
        ? {
            shouldTimeout: (
              _request: { quoteId: string },
              _quote: MutationQuote,
              unit: { unitLocator: { unitKey: string } }
            ) => unit.unitLocator.unitKey === "delivery",
          }
        : {};
    const { provider, syncSnapshot } = configuredProvider(
      current,
      undefined,
      fault as ConstructorParameters<typeof ReferenceProvider>[2]
    );
    const submitted = proposal("realization", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const delivery = quote.units.find(unit => unit.unitLocator.unitKey === "delivery")!;
    const goods = quote.units.find(unit => unit.unitLocator.unitKey === "goods_1")!;
    const response = provider.commit({
      quoteId: quote.quoteId,
      acceptanceConstraints:
        faultOnDelivery === "REFUSED"
          ? [
              {
                effectId: delivery.effects[0].effectId,
                operator: "<=" as const,
                value: { type: "money" as const, amount: "-1.00", currency: "USD" },
              },
            ]
          : [],
    });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    return { quote, submitted, response, delivery, goods };
  }

  it("does not let a refused delivery satisfier read as realized satisfaction", () => {
    const { quote, submitted, response, delivery, goods } = refusedSatisfierResponse("REFUSED");

    // Admission-time truth is unchanged: the transition WAS present when
    // admission was evaluated, so the entry stays PASSED and is not rewritten.
    const passed = response.admissionReport.coverage[0];
    expect(passed.status).toBe("PASSED");
    if (passed.status !== "PASSED") throw new Error("Expected PASSED");
    expect(passed.satisfactions?.[0]).toMatchObject({
      source: "CURRENT_REQUEST",
      unitRef: delivery.unitRef,
    });

    // The execution outcome contradicts it, and the response remains valid:
    // a refused satisfier is a legitimate non-atomic outcome, not a
    // malformed response.
    const result = response.commitResult;
    expect(result.unitResults.find(item => item.unitRef === delivery.unitRef)?.outcome)
      .toBe("REFUSED");
    expect(result.unitResults.find(item => item.unitRef === goods.unitRef)?.outcome)
      .toBe("APPLIED");
    expect(() => assertCommitResponseWellFormed(quote, submitted, response)).not.toThrow();

    // What must NOT happen is a reader taking the pass at face value. The
    // derived correlation makes the contradiction machine-visible.
    const realization = deriveSatisfactionRealization(response.admissionReport, result);
    expect(realization.allRealized).toBe(false);
    expect(realization.entries).toEqual([
      {
        relationId: "retail:goods_redeem_requires_delivery_redeem",
        source: "CURRENT_REQUEST",
        unitRef: delivery.unitRef,
        realization: "NOT_REALIZED",
        outcome: "REFUSED",
      },
    ]);
  });

  it("reports realization as indeterminate when the satisfier is INDETERMINATE", () => {
    const { quote, submitted, response, delivery } = refusedSatisfierResponse("INDETERMINATE");
    expect(response.commitResult.unitResults.find(item => item.unitRef === delivery.unitRef)
      ?.outcome).toBe("INDETERMINATE");
    expect(() => assertCommitResponseWellFormed(quote, submitted, response)).not.toThrow();

    const realization = deriveSatisfactionRealization(
      response.admissionReport, response.commitResult
    );
    expect(realization.allRealized).toBe(false);
    expect(realization.entries[0]).toMatchObject({
      unitRef: delivery.unitRef,
      realization: "INDETERMINATE",
      outcome: "INDETERMINATE",
    });
  });

  it("reports realization as realized when the satisfier is APPLIED", () => {
    const { quote, submitted, response, delivery } = refusedSatisfierResponse("APPLIED");
    expect(response.commitResult.unitResults.every(item => item.outcome === "APPLIED")).toBe(true);
    expect(() => assertCommitResponseWellFormed(quote, submitted, response)).not.toThrow();

    const realization = deriveSatisfactionRealization(
      response.admissionReport, response.commitResult
    );
    expect(realization.allRealized).toBe(true);
    expect(realization.entries[0]).toMatchObject({
      unitRef: delivery.unitRef,
      realization: "REALIZED",
      outcome: "APPLIED",
    });
  });

  it("treats prior-final evidence as having no execution outcome in this response", () => {
    const current = { value: orderState({
      delivery: {
        kind: "DELIVERY", state: "REDEEMED",
        transitionHistory: [{
          status: "FINAL" as const,
          transitionRef: "prior-redeem",
          transition: { unitKey: "delivery", operation: "REDEEM" as const },
          finalizedAt: "2026-09-01T12:00:00Z",
        }],
      },
    }) };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("prior-realization", [{ unitKey: "goods_1", operation: "REDEEM" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] },
      new Date("2026-09-02T00:00:00Z")
    );
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const realization = deriveSatisfactionRealization(
      response.admissionReport, response.commitResult
    );
    // Prior-final evidence is REALIZED: the record is only admissible when
    // the cited transition is already final, so the satisfaction occurred.
    // `source` distinguishes historical realization from current-request
    // realization, so the verdict itself need not.
    expect(realization.entries[0]).toMatchObject({
      source: "PRIOR_FINAL_TRANSITION",
      realization: "REALIZED",
    });
    // It carries no outcome, because this response did not execute it.
    expect(realization.entries[0].outcome).toBeUndefined();
    expect(realization.allRealized).toBe(true);
  });

  it("realizes a mixed relation from both sources under one verdict", () => {
    // The rename matters most here: one relation satisfied partly by this
    // request and partly by prior final history is fully realized when the
    // current-request part applies. Under the old NOT_APPLICABLE value the
    // historical half reported no verdict, which understated the evidence.
    const current = { value: orderState({
      goods_2: {
        kind: "GOODS", state: "CANCELLED",
        transitionHistory: [{
          status: "FINAL" as const,
          transitionRef: "prior-cancel-2",
          transition: { unitKey: "goods_2", operation: "CANCEL" as const },
          finalizedAt: "2026-09-01T12:00:00Z",
        }],
      },
    }) };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("mixed-realization", [
      { unitKey: "delivery", operation: "CANCEL" },
      { unitKey: "goods_1", operation: "CANCEL" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] },
      new Date("2026-09-02T00:00:00Z")
    );
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const realization = assertCommitResponseWellFormed(quote, submitted, response);
    expect(realization!.entries).toHaveLength(2);
    expect(realization!.entries.every(item => item.realization === "REALIZED")).toBe(true);
    expect(realization!.entries.map(item => item.source).sort())
      .toEqual(["CURRENT_REQUEST", "PRIOR_FINAL_TRANSITION"]);
    // Only the current-request half carries an execution outcome.
    expect(realization!.entries.find(item => item.source === "CURRENT_REQUEST")?.outcome)
      .toBe("APPLIED");
    expect(realization!.entries.find(item => item.source === "PRIOR_FINAL_TRANSITION")?.outcome)
      .toBeUndefined();
    expect(realization!.allRealized).toBe(true);
  });

  it("does not let prior-final realization mask a refused current-request half", () => {
    // allRealized is now a direct "every entry REALIZED" test, so a realized
    // historical half must not offset a refused current one.
    const { response } = refusedSatisfierResponse("REFUSED");
    const mixed = structuredClone(response.admissionReport);
    const entry = mixed.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    entry.satisfactions = [
      ...entry.satisfactions,
      {
        source: "PRIOR_FINAL_TRANSITION" as const,
        unitLocator: { scopeRef: "retail:order_799", unitKey: "goods_2" },
        transition: { unitKey: "goods_2", operation: "REDEEM" },
        transitionRef: "prior-redeem-2",
        finalizedAt: "2026-09-01T12:00:00Z",
      },
    ];
    const realization = deriveSatisfactionRealization(mixed, response.commitResult);
    expect(realization.entries.map(item => item.realization).sort())
      .toEqual(["NOT_REALIZED", "REALIZED"]);
    expect(realization.allRealized).toBe(false);
  });

  it("rejects current-request evidence citing a unit with no execution result", () => {
    const { quote, submitted, response } = refusedSatisfierResponse("APPLIED");
    const orphaned = structuredClone(response);
    orphaned.commitResult.unitResults = orphaned.commitResult.unitResults.filter(
      item => item.unitRef !== (
        (orphaned.admissionReport.coverage[0] as { satisfactions: Array<{ unitRef: string }> })
          .satisfactions[0].unitRef
      )
    );
    expect(() => deriveSatisfactionRealization(orphaned.admissionReport, orphaned.commitResult))
      .toThrow(/execution-time realization cannot be determined/);
    // The same response also fails coverage validation, since unitResults
    // must cover every quoted unit.
    expect(() => assertCommitResponseWellFormed(quote, submitted, orphaned)).toThrow(MseViolation);
  });

  it("returns realization from the standard validation path, not just a helper", () => {
    // Point of this test: a consumer that merely validates the response
    // RECEIVES the execution-time reading. It cannot end up trusting a bare
    // PASSED by forgetting to call an optional utility.
    const { quote, submitted, response, delivery } = refusedSatisfierResponse("REFUSED");
    const realization = assertCommitResponseWellFormed(quote, submitted, response);
    expect(realization).toBeDefined();
    expect(realization!.allRealized).toBe(false);
    expect(realization!.entries).toEqual([
      {
        relationId: "retail:goods_redeem_requires_delivery_redeem",
        source: "CURRENT_REQUEST",
        unitRef: delivery.unitRef,
        realization: "NOT_REALIZED",
        outcome: "REFUSED",
      },
    ]);
    // And it agrees with the standalone helper.
    expect(realization).toEqual(
      deriveSatisfactionRealization(response.admissionReport, response.commitResult)
    );
  });

  it("returns no realization for an admission refusal, where nothing executed", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("refused-path", [{ unitKey: "delivery", operation: "CANCEL" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    expect(response.kind).toBe("ADMISSION_REFUSED");
    expect(assertCommitResponseWellFormed(quote, submitted, response)).toBeUndefined();
  });

  it("lets the provider itself answer the realization question post-commit", () => {
    // The consumer obligation is dischargeable from the reference
    // implementation, not only from a validator the caller might not run.
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("provider-realization", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const delivery = quote.units.find(unit => unit.unitLocator.unitKey === "delivery")!;
    provider.commit({
      quoteId: quote.quoteId,
      acceptanceConstraints: [{
        effectId: delivery.effects[0].effectId,
        operator: "<=",
        value: { type: "money", amount: "-1.00", currency: "USD" },
      }],
    });
    const realization = provider.satisfactionRealization(quote.quoteId);
    expect(realization?.allRealized).toBe(false);
    expect(realization?.entries[0]).toMatchObject({
      unitRef: delivery.unitRef,
      realization: "NOT_REALIZED",
    });
    // An unknown quote yields no verdict, so a caller cannot read absence as
    // permission to assume the favorable case.
    expect(provider.satisfactionRealization("quote_does_not_exist")).toBeUndefined();
  });

  it("rejects a claimed realization report that disagrees with the derivation", () => {
    const { response } = refusedSatisfierResponse("REFUSED");
    const derived = deriveSatisfactionRealization(
      response.admissionReport, response.commitResult
    );
    expect(() => assertSatisfactionRealizationConsistent(
      response.admissionReport, response.commitResult, derived
    )).not.toThrow();

    const lied = structuredClone(derived);
    lied.entries[0].realization = "REALIZED";
    lied.allRealized = true;
    expect(() => assertSatisfactionRealizationConsistent(
      response.admissionReport, response.commitResult, lied
    )).toThrow(/disagrees with the derivation/);
  });

  it("keeps REQUIRES_COINCLUSION non-atomic: no unit waits for its satisfier", () => {
    const { response, delivery, goods } = refusedSatisfierResponse("REFUSED");
    // goods_1 is APPLIED even though its declared satisfier was REFUSED. The
    // relation gates admission, not dispatch order, and this revision does
    // not change that.
    expect(response.commitResult.unitResults.find(item => item.unitRef === goods.unitRef)
      ?.outcome).toBe("APPLIED");
    expect(response.commitResult.unitResults.find(item => item.unitRef === delivery.unitRef)
      ?.outcome).toBe("REFUSED");
    expect(response.commitResult.aggregateHint).toBe("MIXED");
  });
});

describe("satisfaction-evidence completeness against the required participant set", () => {
  it("states the complete required participant set on a two-participant pass", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("complete-set", [
      { unitKey: "delivery", operation: "CANCEL" },
      { unitKey: "goods_1", operation: "CANCEL" },
      { unitKey: "goods_2", operation: "CANCEL" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const passed = response.admissionReport.coverage[0];
    if (passed.status !== "PASSED") throw new Error("Expected PASSED");
    expect(passed.requiredParticipants?.map(item => item.unitLocator.unitKey)).toEqual([
      "goods_1", "goods_2",
    ]);
    expect(passed.satisfactions).toHaveLength(2);
    expect(() => assertAdmissionReportWellFormed(quote, submitted, response.admissionReport))
      .not.toThrow();
    expect(() => assertCommitResponseWellFormed(quote, submitted, response)).not.toThrow();
  });

  it("rejects a PASSED citing only one of two required participants", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("subset-evidence", [
      { unitKey: "delivery", operation: "CANCEL" },
      { unitKey: "goods_1", operation: "CANCEL" },
      { unitKey: "goods_2", operation: "CANCEL" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");

    const subset = structuredClone(response.admissionReport);
    const entry = subset.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    entry.satisfactions = [entry.satisfactions[0]];
    expect(entry.requiredParticipants).toHaveLength(2);
    expect(() => assertAdmissionReportWellFormed(quote, submitted, subset))
      .toThrow(/MUST cover the required participant set exactly/);
  });

  it("rejects evidence for a participant outside the stated required set", () => {
    // Uses the redeem gate with prior-final evidence, where the cited
    // participant is NOT a quoted unit. That isolates the out-of-set rule
    // from the core-visible grounding rule, which only constrains quoted
    // units in the relation's scope.
    const current = { value: orderState({
      delivery: {
        kind: "DELIVERY", state: "REDEEMED",
        transitionHistory: [{
          status: "FINAL" as const,
          transitionRef: "prior-redeem",
          transition: { unitKey: "delivery", operation: "REDEEM" as const },
          finalizedAt: "2026-09-01T12:00:00Z",
        }],
      },
    }) };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("outside-set", [{ unitKey: "goods_1", operation: "REDEEM" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] },
      new Date("2026-09-02T00:00:00Z")
    );
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const swapped = structuredClone(response.admissionReport);
    const entry = swapped.coverage[0];
    if (entry.status !== "PASSED" || !entry.requiredParticipants) {
      throw new Error("Expected required participants");
    }
    // The stated set names a participant the evidence does not cite, and the
    // evidence cites one the set does not name. Neither is a quoted unit, so
    // only the exact-correspondence rules can catch it.
    entry.requiredParticipants = [{
      unitLocator: { scopeRef: "retail:order_799", unitKey: "goods_2" },
      transition: { unitKey: "goods_2", operation: "REDEEM" },
    }];
    expect(() => assertAdmissionReportWellFormed(quote, submitted, swapped))
      .toThrow(/outside the required participant set/);
  });

  it("rejects a required set that omits a co-included quoted unit", () => {
    // Independent grounding: shrinking BOTH arrays together would otherwise
    // make the completeness check tautological. Core derives the co-included
    // quoted units itself, so this forgery is caught without binding help.
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("ungrounded", [
      { unitKey: "delivery", operation: "CANCEL" },
      { unitKey: "goods_1", operation: "CANCEL" },
      { unitKey: "goods_2", operation: "CANCEL" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const goods2 = quote.units.find(unit => unit.unitLocator.unitKey === "goods_2")!;

    const forged = structuredClone(response.admissionReport);
    const entry = forged.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions || !entry.requiredParticipants) {
      throw new Error("Expected evidence and required participants");
    }
    // Drop goods_2 from BOTH the evidence and the stated required set, so the
    // two arrays still agree with each other.
    entry.satisfactions = entry.satisfactions.filter(
      item => !("unitRef" in item) || item.unitRef !== goods2.unitRef
    );
    entry.requiredParticipants = entry.requiredParticipants.filter(
      item => item.unitLocator.unitKey !== "goods_2"
    );
    expect(entry.satisfactions).toHaveLength(1);
    expect(entry.requiredParticipants).toHaveLength(1);
    expect(() => assertAdmissionReportWellFormed(quote, submitted, forged))
      .toThrow(/omits quoted unit/);
  });

  it("allows a required participant absent from the quote, satisfied by prior history", () => {
    // The grounding rule is a LOWER bound, not equality: a required
    // participant satisfied by prior final history is not a quoted unit, and
    // core must not demand that the stated set contain only quoted units.
    const current = { value: orderState({
      goods_2: {
        kind: "GOODS", state: "CANCELLED",
        transitionHistory: [{
          status: "FINAL" as const,
          transitionRef: "prior-cancel-2",
          transition: { unitKey: "goods_2", operation: "CANCEL" as const },
          finalizedAt: "2026-09-01T12:00:00Z",
        }],
      },
    }) };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("mixed-grounded", [
      { unitKey: "delivery", operation: "CANCEL" },
      { unitKey: "goods_1", operation: "CANCEL" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] },
      new Date("2026-09-02T00:00:00Z")
    );
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const entry = response.admissionReport.coverage[0];
    if (entry.status !== "PASSED") throw new Error("Expected PASSED");
    // goods_2 is required and stated, but is not in the quote.
    expect(entry.requiredParticipants?.map(item => item.unitLocator.unitKey).sort())
      .toEqual(["goods_1", "goods_2"]);
    expect(quote.units.map(unit => unit.unitLocator.unitKey)).not.toContain("goods_2");
    expect(entry.satisfactions?.map(item => item.source).sort())
      .toEqual(["CURRENT_REQUEST", "PRIOR_FINAL_TRANSITION"]);
    expect(() => assertAdmissionReportWellFormed(quote, submitted, response.admissionReport))
      .not.toThrow();
    expect(() => assertCommitResponseWellFormed(quote, submitted, response)).not.toThrow();
  });

  it("has binding trace conformance validate the part core cannot derive", () => {
    // Core's grounding rule is a lower bound, so a forged prior-history
    // participant stays invisible to it. The binding re-derives the required
    // set from real state and rejects the forgery, which is the obligation
    // the spec places on trace conformance.
    const current = { value: orderState({
      goods_2: {
        kind: "GOODS", state: "CANCELLED",
        transitionHistory: [{
          status: "FINAL" as const,
          transitionRef: "prior-cancel-2",
          transition: { unitKey: "goods_2", operation: "CANCEL" as const },
          finalizedAt: "2026-09-01T12:00:00Z",
        }],
      },
    }) };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("trace-grounding", [
      { unitKey: "delivery", operation: "CANCEL" },
      { unitKey: "goods_1", operation: "CANCEL" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] },
      new Date("2026-09-02T00:00:00Z")
    );
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");

    const forged = structuredClone(response.admissionReport);
    const entry = forged.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions || !entry.requiredParticipants) {
      throw new Error("Expected evidence and required participants");
    }
    // Rename the prior-history participant in BOTH arrays, keeping them
    // mutually consistent and out of core's core-visible lower bound.
    for (const participant of entry.requiredParticipants) {
      if (participant.unitLocator.unitKey === "goods_2") {
        participant.unitLocator.unitKey = "goods_9";
      }
    }
    for (const satisfaction of entry.satisfactions) {
      if ("unitLocator" in satisfaction && satisfaction.unitLocator?.unitKey === "goods_2") {
        satisfaction.unitLocator.unitKey = "goods_9";
      }
    }
    // Core accepts it: goods_9 is not a quoted unit, so the lower bound is
    // silent and the two arrays agree.
    expect(() => assertAdmissionReportWellFormed(quote, submitted, forged)).not.toThrow();
    // The binding does not.
    expect(() => assertRetailAdmissionTrace(submitted, quote, forged, current.value))
      .toThrow(/contradicts the retail binding evaluation trace/);
  });

  it("requires a participant set whenever the relation declares pass evidence required", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("missing-set", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const stripped = structuredClone(response.admissionReport);
    const entry = stripped.coverage[0];
    if (entry.status !== "PASSED") throw new Error("Expected PASSED");
    delete entry.requiredParticipants;
    expect(() => assertAdmissionReportWellFormed(quote, submitted, stripped))
      .toThrow(/does not state the participant set/);
  });

  it("rejects a malformed, empty, duplicated, or out-of-scope participant set", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("malformed-set", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");

    const mutate = (change: (entry: Record<string, unknown>) => void) => {
      const clone = structuredClone(response.admissionReport);
      change(clone.coverage[0] as unknown as Record<string, unknown>);
      return clone;
    };

    expect(() => assertAdmissionReportWellFormed(
      quote, submitted, mutate(entry => { entry.requiredParticipants = []; })
    )).toThrow(/empty required participant set/);

    expect(() => assertAdmissionReportWellFormed(
      quote, submitted, mutate(entry => {
        entry.requiredParticipants = [{ unitLocator: { scopeRef: "retail:order_799", unitKey: "delivery" } }];
      })
    )).toThrow(/Malformed required participant/);

    expect(() => assertAdmissionReportWellFormed(
      quote, submitted, mutate(entry => {
        const participants = entry.requiredParticipants as unknown[];
        entry.requiredParticipants = [participants[0], structuredClone(participants[0])];
      })
    )).toThrow(/repeats required participant/);

    expect(() => assertAdmissionReportWellFormed(
      quote, submitted, mutate(entry => {
        entry.requiredParticipants = [{
          unitLocator: { scopeRef: "retail:another_order", unitKey: "delivery" },
          transition: { unitKey: "delivery", operation: "REDEEM" },
        }];
      })
    )).toThrow(/outside declared scope/);
  });
});

describe("temporal consistency of prior-final satisfaction evidence", () => {
  function priorFinalResponse(finalizedAt: string, evaluatedAt: string) {
    const current = { value: orderState({
      delivery: {
        kind: "DELIVERY", state: "REDEEMED",
        transitionHistory: [{
          status: "FINAL" as const,
          transitionRef: "prior-redeem",
          transition: { unitKey: "delivery", operation: "REDEEM" as const },
          finalizedAt,
        }],
      },
    }) };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("temporal", [{ unitKey: "goods_1", operation: "REDEEM" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    return {
      quote,
      submitted,
      current,
      commit: () => provider.commit(
        { quoteId: quote.quoteId, acceptanceConstraints: [] }, new Date(evaluatedAt)
      ),
    };
  }

  it("rejects prior-final evidence finalized after the report's evaluatedAt", () => {
    const { commit } = priorFinalResponse("2026-09-03T00:00:00Z", "2026-09-02T00:00:00Z");
    expect(() => commit()).toThrow(/finalizedAt <= evaluatedAt/);
  });

  it("accepts prior-final evidence finalized exactly at evaluatedAt", () => {
    const { quote, submitted, commit } = priorFinalResponse(
      "2026-09-02T00:00:00Z", "2026-09-02T00:00:00Z"
    );
    const response = commit();
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const entry = response.admissionReport.coverage[0];
    if (entry.status !== "PASSED") throw new Error("Expected PASSED");
    expect(entry.satisfactions?.[0]).toMatchObject({
      source: "PRIOR_FINAL_TRANSITION",
      finalizedAt: "2026-09-02T00:00:00Z",
    });
    expect(response.admissionReport.evaluatedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(() => assertAdmissionReportWellFormed(quote, submitted, response.admissionReport))
      .not.toThrow();
    expect(() => assertCommitResponseWellFormed(quote, submitted, response)).not.toThrow();
  });

  it("accepts prior-final evidence finalized before evaluatedAt", () => {
    const { quote, submitted, commit } = priorFinalResponse(
      "2026-09-01T12:00:00Z", "2026-09-02T00:00:00Z"
    );
    const response = commit();
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    expect(() => assertCommitResponseWellFormed(quote, submitted, response)).not.toThrow();
  });

  it("keeps timestamp-format validation independent of the ordering rule", () => {
    const { quote, submitted, commit } = priorFinalResponse(
      "2026-09-01T12:00:00Z", "2026-09-02T00:00:00Z"
    );
    const response = commit();
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const malformed = structuredClone(response.admissionReport);
    const entry = malformed.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    (entry.satisfactions[0] as { finalizedAt: string }).finalizedAt = "yesterday";
    expect(() => assertAdmissionReportWellFormed(quote, submitted, malformed))
      .toThrow(/MUST be an ISO 8601 timestamp/);
  });

  it("compares instants, not ISO strings, across differing UTC offsets", () => {
    // Regression guard: a lexicographic comparison would reject this, because
    // "2026-09-02T00:00:00Z" > "2026-09-01T19:00:00-05:00" as strings while
    // naming the SAME instant. The rule is about time, not spelling.
    const { quote, submitted, commit } = priorFinalResponse(
      "2026-09-02T00:00:00Z", "2026-09-02T00:00:00Z"
    );
    const response = commit();
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const equivalent = structuredClone(response.admissionReport);
    const entry = equivalent.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    equivalent.evaluatedAt = "2026-09-01T19:00:00-05:00";
    (entry.satisfactions[0] as { finalizedAt: string }).finalizedAt = "2026-09-02T00:00:00Z";
    expect(Date.parse("2026-09-02T00:00:00Z"))
      .toBe(Date.parse("2026-09-01T19:00:00-05:00"));
    expect(() => assertAdmissionReportWellFormed(quote, submitted, equivalent)).not.toThrow();

    // And an offset-shifted evaluatedAt that really is EARLIER still rejects.
    const shifted = structuredClone(response.admissionReport);
    const shiftedEntry = shifted.coverage[0];
    if (shiftedEntry.status !== "PASSED" || !shiftedEntry.satisfactions) {
      throw new Error("Expected evidence");
    }
    shifted.evaluatedAt = "2026-09-02T00:00:00+02:00";
    (shiftedEntry.satisfactions[0] as { finalizedAt: string }).finalizedAt =
      "2026-09-02T00:00:00Z";
    expect(() => assertAdmissionReportWellFormed(quote, submitted, shifted))
      .toThrow(/finalizedAt <= evaluatedAt/);
  });

  it("skips the ordering rule when coverage is validated without a report instant", () => {
    const { quote, commit } = priorFinalResponse("2026-09-01T12:00:00Z", "2026-09-02T00:00:00Z");
    const response = commit();
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const later = structuredClone(response.admissionReport);
    const entry = later.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    (entry.satisfactions[0] as { finalizedAt: string }).finalizedAt = "2027-01-01T00:00:00Z";
    // Bare coverage validation has no evaluation instant to compare against.
    expect(() => assertAdmissionCoverageWellFormed(quote, [], later.coverage)).not.toThrow();
    // Supplying it applies the rule.
    expect(() => assertAdmissionCoverageWellFormed(quote, [], later.coverage, later.evaluatedAt))
      .toThrow(/finalizedAt <= evaluatedAt/);
  });
});
