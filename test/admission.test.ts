import { describe, expect, it } from "vitest";
import { ReferenceProvider } from "../src/core/reference-provider";
import {
  assertAdmissionCoverageWellFormed,
  canonicalJson,
  deepJsonEqual,
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
  selectRetailPriorFinal,
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

  it("catches locator and transition mismatches, leaving consistent lies to the binding", () => {
    const current = { value: orderState({
      delivery: {
        kind: "DELIVERY", state: "REDEEMED",
        transitionHistory: [finalTransition("delivery", "REDEEM", "prior-redeem")],
      },
    }) };
    const submitted = proposal("trace-evidence", [{ unitKey: "goods_1", operation: "REDEEM" }]);
    const { quote, response } = admitted(current, submitted);

    // Wrong unit: caught by core, because the entry states which participant
    // was required and the evidence cites a different one.
    const wrongUnit = structuredClone(response.admissionReport);
    const evidence = wrongUnit.coverage[0];
    if (evidence.status !== "PASSED" || evidence.satisfactions?.[0].source !== "PRIOR_FINAL_TRANSITION") {
      throw new Error("Expected prior evidence");
    }
    evidence.satisfactions[0].unitLocator.unitKey = "goods_2";
    expect(() => assertAdmissionReportWellFormed(quote, submitted, wrongUnit)).toThrow(
      /outside the required participant set/
    );
    expect(() => assertRetailAdmissionTrace(submitted, quote, wrongUnit, current.value)).toThrow();

    // Wrong transition on the right unit: also caught by core now, because a
    // required participant is (locator, transition) and the evidence must
    // match both. A CANCEL never discharges a required REDEEM.
    const wrongTransition = structuredClone(response.admissionReport);
    const wrong = wrongTransition.coverage[0];
    if (wrong.status !== "PASSED" || wrong.satisfactions?.[0].source !== "PRIOR_FINAL_TRANSITION") {
      throw new Error("Expected prior evidence");
    }
    wrong.satisfactions[0].transition = { unitKey: "delivery", operation: "CANCEL" };
    expect(() => assertAdmissionReportWellFormed(quote, submitted, wrongTransition))
      .toThrow(/differs from the transition that participant was required to contribute/);
    expect(() => assertRetailAdmissionTrace(submitted, quote, wrongTransition, current.value)).toThrow();

    // The real boundary: a producer that forges the required transition AND
    // the evidence transition CONSISTENTLY is internally coherent, so core
    // cannot disprove it. Only the binding, re-reading actual history, can.
    const consistentLie = structuredClone(response.admissionReport);
    const lied = consistentLie.coverage[0];
    if (lied.status !== "PASSED" || !lied.satisfactions || !lied.requiredParticipants) {
      throw new Error("Expected evidence and required participants");
    }
    lied.satisfactions[0].transition = { unitKey: "delivery", operation: "CANCEL" };
    lied.requiredParticipants[0].transition = { unitKey: "delivery", operation: "CANCEL" };
    expect(() => assertAdmissionReportWellFormed(quote, submitted, consistentLie)).not.toThrow();
    expect(() => assertRetailAdmissionTrace(submitted, quote, consistentLie, current.value))
      .toThrow(/contradicts the retail binding evaluation trace/);
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

  it("does not infer relation participation from shared scope", () => {
    // The relation is goods-redeem-requires-delivery-redeem. `goods_2 CANCEL`
    // shares the order scope but is NOT a participant in that relation.
    // `scopeRef` says where locators resolve; it does not make every
    // transition in the scope a participant. Core must not invent a floor
    // from it, and this proposal must pass admission.
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("unrelated-same-scope", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "goods_2", operation: "CANCEL" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    expect(response.kind).toBe("COMMIT_RESULT");
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");

    const redeem = response.admissionReport.coverage.find(
      item => item.relationId === "retail:goods_redeem_requires_delivery_redeem"
    )!;
    if (redeem.status !== "PASSED") throw new Error("Expected PASSED");
    // Only delivery is a participant. goods_2 is absent from both arrays.
    expect(redeem.requiredParticipants?.map(item => item.unitLocator.unitKey)).toEqual(["delivery"]);
    expect(redeem.satisfactions).toHaveLength(1);
    expect(() => assertAdmissionReportWellFormed(quote, submitted, response.admissionReport))
      .not.toThrow();
    expect(() => assertCommitResponseWellFormed(quote, submitted, response)).not.toThrow();
    expect(() => assertRetailAdmissionTrace(submitted, quote, response.admissionReport, current.value))
      .not.toThrow();
  });

  it("admits the COMPLETE-witness amendment that adds the missing participant", () => {
    // The binding's own repair path must satisfy the same validators as a
    // directly submitted equivalent proposal. A scope-derived floor broke
    // this: the amended quote still carried the unrelated goods_2 CANCEL.
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("needs-repair", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "goods_2", operation: "CANCEL" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const refused = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    const failures = admissionFailures(refused);
    const witness = failures[0].witness;
    if (witness.disposition !== "COMPLETE") throw new Error("Expected COMPLETE witness");
    expect(witness.requiredTransitions.map(item => item.unitLocator.unitKey)).toEqual(["delivery"]);

    const amended = amendRetailProposal(
      submitted, witness.requiredTransitions, current.value, "repaired"
    );
    const amendedQuote = provider.quote(amended);
    syncSnapshot();
    const response = provider.commit({
      quoteId: amendedQuote.quoteId, acceptanceConstraints: [],
    });
    expect(response.kind).toBe("COMMIT_RESULT");
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    expect(() => assertCommitResponseWellFormed(amendedQuote, amended, response)).not.toThrow();
    expect(() => assertRetailAdmissionTrace(
      amended, amendedQuote, response.admissionReport, current.value
    )).not.toThrow();
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
    // A conformant retail evaluator now filters future-dated history, so
    // this report is constructed directly: the core rule must still hold
    // for evidence from any producer, conformant or not.
    const { quote, submitted, commit } = priorFinalResponse(
      "2026-09-01T12:00:00Z", "2026-09-02T00:00:00Z"
    );
    const response = commit();
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const forged = structuredClone(response.admissionReport);
    const entry = forged.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    (entry.satisfactions[0] as { finalizedAt: string }).finalizedAt = "2026-09-03T00:00:00Z";
    expect(() => assertAdmissionReportWellFormed(quote, submitted, forged))
      .toThrow(/finalizedAt <= evaluatedAt/);
  });

  it("has a conformant evaluator never emit future-dated history", () => {
    // The complementary half: the binding filters it out rather than
    // emitting evidence core would reject.
    const { commit } = priorFinalResponse("2026-09-03T00:00:00Z", "2026-09-02T00:00:00Z");
    const response = commit();
    expect(response.kind).toBe("ADMISSION_REFUSED");
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

/**
 * Adversarial vectors for the UCP #799 correctness repair: removal of the
 * invalid scope-derived participant floor, transition-aware exact coverage,
 * prior-final source aliasing, structural transition equality, non-vacuous
 * allRealized, and expiry result persistence.
 */
describe("transition-aware exact coverage", () => {
  function redeemResponse() {
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("transition-aware", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    return { current, quote, submitted, response };
  }

  it("rejects CURRENT_REQUEST evidence for the right unit but wrong transition", () => {
    const { quote, submitted, response } = redeemResponse();
    const forged = structuredClone(response.admissionReport);
    const entry = forged.coverage[0];
    if (entry.status !== "PASSED" || !entry.requiredParticipants) {
      throw new Error("Expected required participants");
    }
    // Keep the evidence consistent with its quoted unit, but change what the
    // participant was REQUIRED to contribute. The locator still matches.
    entry.requiredParticipants[0].transition = { unitKey: "delivery", operation: "CANCEL" };
    expect(() => assertAdmissionReportWellFormed(quote, submitted, forged))
      .toThrow(/differs from the transition that participant was required to contribute/);
  });

  it("rejects PRIOR_FINAL_TRANSITION evidence for the right unit but wrong transition", () => {
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
    const submitted = proposal("prior-wrong-transition", [
      { unitKey: "goods_1", operation: "REDEEM" },
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
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    entry.satisfactions[0].transition = { unitKey: "delivery", operation: "CANCEL" };
    expect(() => assertAdmissionReportWellFormed(quote, submitted, forged))
      .toThrow(/differs from the transition that participant was required to contribute/);
  });

  it("still rejects a required set repeating one binding-scoped unit", () => {
    // Duplicate detection stays locator-based even though the map now
    // carries transitions: one relation must not state two required
    // transitions for the same unit.
    const { quote, submitted, response } = redeemResponse();
    const forged = structuredClone(response.admissionReport);
    const entry = forged.coverage[0];
    if (entry.status !== "PASSED" || !entry.requiredParticipants) {
      throw new Error("Expected required participants");
    }
    entry.requiredParticipants = [
      entry.requiredParticipants[0],
      {
        unitLocator: { scopeRef: "retail:order_799", unitKey: "delivery" },
        transition: { unitKey: "delivery", operation: "CANCEL" },
      },
    ];
    expect(() => assertAdmissionReportWellFormed(quote, submitted, forged))
      .toThrow(/repeats required participant/);
  });
});

/**
 * Model B (historical coexistence). Core does not reject prior-final
 * evidence for sharing a locator, or even a locator and an opaque
 * transition value, with the current quote. `transitionRef` identifies a
 * historical occurrence; `transition` is an opaque operation value the
 * protocol never declares unique per unit. Authenticating the occurrence is
 * binding work.
 */
describe("prior-final / current-quote coexistence", () => {
  function refusedDeliveryResponse(id: string) {
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal(id, [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const delivery = quote.units.find(unit => unit.unitLocator.unitKey === "delivery")!;
    const response = provider.commit(
      {
        quoteId: quote.quoteId,
        acceptanceConstraints: [{
          effectId: delivery.effects[0].effectId,
          operator: "<=",
          value: { type: "money", amount: "-1.00", currency: "USD" },
        }],
      },
      new Date("2026-09-02T00:00:00Z")
    );
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    return { current, quote, submitted, response, delivery };
  }

  it("accepts genuine historical A alongside a different current B", () => {
    const { current, quote, submitted, response } = refusedDeliveryResponse("hist-a-curr-b");
    const variant = structuredClone(response.admissionReport);
    const entry = variant.coverage[0];
    if (entry.status !== "PASSED" || !entry.requiredParticipants) {
      throw new Error("Expected required participants");
    }
    const historical = { unitKey: "delivery", operation: "CANCEL" };
    entry.satisfactions = [{
      source: "PRIOR_FINAL_TRANSITION",
      unitLocator: { scopeRef: "retail:order_799", unitKey: "delivery" },
      transition: historical,
      transitionRef: "occurrence-cancel-1",
      finalizedAt: "2026-09-01T12:00:00Z",
    }];
    entry.requiredParticipants[0].transition = historical;
    expect(() => assertAdmissionReportWellFormed(quote, submitted, variant)).not.toThrow();
    // Binding still judges it on retail semantics.
    expect(() => assertRetailAdmissionTrace(submitted, quote, variant, current.value)).toThrow();
  });

  it("accepts genuine historical A alongside the SAME current transition A", () => {
    // The case that refutes the pair rule. A repeatable operation can have
    // a final occurrence in history and a fresh request now; the two are
    // distinct events distinguished by transitionRef, and the current
    // attempt failing says nothing about the historical one.
    const { current, quote, submitted, response } = refusedDeliveryResponse("hist-a-curr-a");
    const variant = structuredClone(response.admissionReport);
    const entry = variant.coverage[0];
    if (entry.status !== "PASSED") throw new Error("Expected PASSED");
    const sameShape = { unitKey: "delivery", operation: "REDEEM" };
    entry.satisfactions = [{
      source: "PRIOR_FINAL_TRANSITION",
      unitLocator: { scopeRef: "retail:order_799", unitKey: "delivery" },
      transition: sameShape,
      transitionRef: "occurrence-redeem-earlier",
      finalizedAt: "2026-09-01T12:00:00Z",
    }];
    // Core does not reject: it cannot prove the earlier occurrence false.
    expect(() => assertAdmissionReportWellFormed(quote, submitted, variant)).not.toThrow();
    // Authenticating the occurrence is the binding's job, and here the
    // claimed history does not exist in real state.
    expect(() => assertRetailAdmissionTrace(submitted, quote, variant, current.value))
      .toThrow(/contradicts the retail binding evaluation trace/);
  });

  it("still correlates current-request evidence with its own unit result", () => {
    // Removing the alias rule must not weaken execution correlation for
    // evidence that is actually labelled CURRENT_REQUEST.
    const { quote, submitted, response, delivery } = refusedDeliveryResponse("still-correlated");
    const realization = assertCommitResponseWellFormed(quote, submitted, response);
    expect(realization?.entries).toEqual([
      {
        relationId: "retail:goods_redeem_requires_delivery_redeem",
        source: "CURRENT_REQUEST",
        unitRef: delivery.unitRef,
        realization: "NOT_REALIZED",
        outcome: "REFUSED",
      },
    ]);
    expect(realization?.allRealized).toBe(false);
  });

  it("rejects fabricated history through binding trace, not core", () => {
    const { current, quote, submitted, response } = refusedDeliveryResponse("fabricated");
    const forged = structuredClone(response.admissionReport);
    const entry = forged.coverage[0];
    if (entry.status !== "PASSED" || !entry.requiredParticipants) {
      throw new Error("Expected required participants");
    }
    const invented = { unitKey: "delivery", operation: "REDEEM" };
    entry.satisfactions = [{
      source: "PRIOR_FINAL_TRANSITION",
      unitLocator: { scopeRef: "retail:order_799", unitKey: "delivery" },
      transition: invented,
      transitionRef: "never-occurred",
      finalizedAt: "2026-09-01T00:00:00Z",
    }];
    entry.requiredParticipants[0].transition = invented;
    expect(() => assertAdmissionReportWellFormed(quote, submitted, forged)).not.toThrow();
    expect(() => assertRetailAdmissionTrace(submitted, quote, forged, current.value))
      .toThrow(/contradicts the retail binding evaluation trace/);
  });
});

describe("limits of core-provable prior-final evidence", () => {
  it("documents that a DIFFERENT forged prior transition is binding-owned", () => {
    // Counterexample found during the post-implementation adversarial pass.
    // State it precisely: this is NOT "the unit was refused but realization
    // says realized". A genuine prior transition A can coexist with a
    // refused different current transition B on one unit.
    //
    // The real limitation is that a non-conformant producer can change BOTH
    // requiredParticipants AND the PRIOR_FINAL evidence, consistently, to a
    // different historical transition that core can neither authenticate
    // nor evaluate for sufficiency. Core cannot know whether the cited
    // history occurred, whether that opaque transition satisfies this
    // relation, or whether a different current transition invalidates it.
    // All three are binding knowledge, so the binding rejects it.
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("forged-different-history", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const delivery = quote.units.find(unit => unit.unitLocator.unitKey === "delivery")!;
    const response = provider.commit(
      {
        quoteId: quote.quoteId,
        acceptanceConstraints: [{
          effectId: delivery.effects[0].effectId,
          operator: "<=",
          value: { type: "money", amount: "-1.00", currency: "USD" },
        }],
      },
      new Date("2026-09-02T00:00:00Z")
    );
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    expect(response.commitResult.unitResults.find(item => item.unitRef === delivery.unitRef)
      ?.outcome).toBe("REFUSED");

    const forged = structuredClone(response.admissionReport);
    const entry = forged.coverage[0];
    if (entry.status !== "PASSED") throw new Error("Expected PASSED");
    const historical = { unitKey: "delivery", operation: "CANCEL" };
    entry.satisfactions = [{
      source: "PRIOR_FINAL_TRANSITION",
      unitLocator: { scopeRef: "retail:order_799", unitKey: "delivery" },
      transition: historical,
      transitionRef: "forged-history",
      finalizedAt: "2026-09-01T00:00:00Z",
    }];
    entry.requiredParticipants = [{
      unitLocator: { scopeRef: "retail:order_799", unitKey: "delivery" },
      transition: historical,
    }];

    // Core accepts the coherent report and derives REALIZED from it.
    expect(() => assertCommitResponseWellFormed(quote, submitted, {
      ...response, admissionReport: forged,
    })).not.toThrow();
    const realization = deriveSatisfactionRealization(forged, response.commitResult);
    expect(realization.entries[0].realization).toBe("REALIZED");

    // The binding does not. Under the current relation shape this class of
    // claim is substantiated by trace conformance, never by core.
    expect(() => assertRetailAdmissionTrace(submitted, quote, forged, current.value))
      .toThrow(/contradicts the retail binding evaluation trace/);
  });
});

describe("structural equality for opaque transitions", () => {
  it("treats object member order as non-semantic", () => {
    expect(deepJsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepJsonEqual({ unitKey: "delivery", operation: "REDEEM" },
                         { operation: "REDEEM", unitKey: "delivery" })).toBe(true);
    // Arrays stay order-sensitive.
    expect(deepJsonEqual([1, 2], [2, 1])).toBe(false);
    expect(deepJsonEqual([1, 2], [1, 2])).toBe(true);
    // Genuine differences still differ.
    expect(deepJsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepJsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepJsonEqual(null, undefined)).toBe(false);
    expect(deepJsonEqual({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(true);
  });

  it("accepts reordered transition members in satisfaction evidence", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("reordered", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const reordered = structuredClone(response.admissionReport);
    const entry = reordered.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions || !entry.requiredParticipants) {
      throw new Error("Expected evidence and required participants");
    }
    // Same content, different insertion order, on both comparisons core makes.
    entry.satisfactions[0].transition = { operation: "REDEEM", unitKey: "delivery" };
    entry.requiredParticipants[0].transition = { operation: "REDEEM", unitKey: "delivery" };
    expect(() => assertAdmissionReportWellFormed(quote, submitted, reordered)).not.toThrow();
  });
});

describe("non-vacuous allRealized and expiry persistence", () => {
  it("reports allRealized false when there are no realization entries", () => {
    // A quote with no declared relations commits successfully and evidences
    // nothing. Zero entries must not read as "everything realized".
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("no-relations", [{ unitKey: "goods_1", operation: "CANCEL" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    expect(quote.admissionRelations).toHaveLength(0);
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const realization = assertCommitResponseWellFormed(quote, submitted, response);
    expect(realization?.entries).toEqual([]);
    expect(realization?.allRealized).toBe(false);
  });

  it("persists results on quote expiry and still answers realization", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot, dispatchCount } = configuredProvider(current);
    const submitted = proposal("expired", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    // Expire the quote after admission would otherwise pass.
    quote.expiresAt = "2026-09-01T00:00:00Z";
    syncSnapshot();
    const response = provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] },
      new Date("2026-09-02T00:00:00Z")
    );
    expect(response.kind).toBe("COMMIT_RESULT");
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    expect(response.commitResult.unitResults.every(
      item => item.outcome === "REFUSED" && item.refusalReason === "QUOTE_EXPIRED"
    )).toBe(true);
    expect(dispatchCount()).toBe(0);

    // The bug: this branch used to return without persisting, so the
    // post-commit realization question could not be answered at all.
    const realization = provider.satisfactionRealization(quote.quoteId);
    expect(realization).toBeDefined();
    expect(realization!.entries.every(item => item.realization === "NOT_REALIZED")).toBe(true);
    expect(realization!.allRealized).toBe(false);
  });

  it("leaves snapshot-mismatch behavior unchanged", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot, dispatchCount } = configuredProvider(current);
    const submitted = proposal("snapshot", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    // Drift the snapshot after quoting.
    current.value = { ...current.value, version: current.value.version + 1 };
    provider.setSnapshot({ orderId: current.value.orderId }, retailSnapshot(current.value));
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    expect(response.commitResult.unitResults.every(
      item => item.outcome === "REFUSED" && item.refusalReason === "SNAPSHOT_MISMATCH"
    )).toBe(true);
    expect(dispatchCount()).toBe(0);
    const realization = provider.satisfactionRealization(quote.quoteId);
    expect(realization?.allRealized).toBe(false);
  });
});

/**
 * Representation-invariant vectors: structural equality of opaque values,
 * unordered-collection semantics for protocol arrays that are sets, and the
 * scope of the derived realization aggregate.
 */
describe("deepJsonEqual unit behavior", () => {
  it("compares JSON semantics: object order free, array order significant", () => {
    // Primitives and identity.
    expect(deepJsonEqual(1, 1)).toBe(true);
    expect(deepJsonEqual("a", "a")).toBe(true);
    expect(deepJsonEqual(true, true)).toBe(true);
    expect(deepJsonEqual(1, "1")).toBe(false);
    expect(deepJsonEqual(0, false)).toBe(false);

    // null vs undefined vs object.
    expect(deepJsonEqual(null, null)).toBe(true);
    expect(deepJsonEqual(null, undefined)).toBe(false);
    expect(deepJsonEqual(null, {})).toBe(false);
    expect(deepJsonEqual(undefined, undefined)).toBe(true);

    // Object member order is not semantic.
    expect(deepJsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepJsonEqual({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(true);

    // Array order IS semantic.
    expect(deepJsonEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepJsonEqual([1, 2, 3], [3, 2, 1])).toBe(false);
    expect(deepJsonEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepJsonEqual([], [])).toBe(true);

    // Arrays and objects are distinct kinds.
    expect(deepJsonEqual([], {})).toBe(false);

    // Unequal key sets and unequal nested values.
    expect(deepJsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepJsonEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(deepJsonEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(deepJsonEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } })).toBe(false);
    expect(deepJsonEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } })).toBe(true);

    // Nested mixture.
    expect(deepJsonEqual(
      { list: [{ p: 1, q: 2 }], flag: false },
      { flag: false, list: [{ q: 2, p: 1 }] }
    )).toBe(true);
  });

  it("documents its behavior for non-JSON values rather than throwing", () => {
    // deepJsonEqual returns a VERDICT, so an out-of-contract value cannot
    // alias another value; it can only answer a question already outside
    // the contract. These assertions pin that behavior.
    expect(deepJsonEqual({ a: undefined }, {})).toBe(false); // present vs absent key
    expect(deepJsonEqual(NaN, NaN)).toBe(false);             // JSON has no NaN
    expect(deepJsonEqual(-0, 0)).toBe(true);                 // JSON has no signed zero
    expect(deepJsonEqual(Infinity, Infinity)).toBe(true);    // reference equality
    const fn = () => 1;
    expect(deepJsonEqual({ f: fn }, { f: fn })).toBe(true);
    expect(deepJsonEqual({ f: fn }, { f: () => 1 })).toBe(false);
    // Exotic objects compare by own enumerable keys, NOT value semantics.
    expect(deepJsonEqual(new Date("2026-01-01"), new Date("2027-06-06"))).toBe(true);
  });

  it("rejects cyclic input instead of overflowing the stack", () => {
    const left: Record<string, unknown> = {};
    left.self = left;
    const right: Record<string, unknown> = {};
    right.self = right;
    expect(() => deepJsonEqual(left, right)).toThrow(/Cyclic value/);
    expect(() => canonicalJson(left)).toThrow(/Cyclic value/);
  });

  it("canonicalJson sorts object keys and preserves array order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ a: [{ z: 1, y: 2 }] })).toBe(canonicalJson({ a: [{ y: 2, z: 1 }] }));
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(-0)).toBe(canonicalJson(0));
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  it("canonicalJson fails closed on every non-JSON value", () => {
    // It produces IDENTITY keys, including snapshot-map keys, so a silent
    // collapse to "null" or "{}" would let unrelated values alias. Each of
    // these previously collided: undefined/NaN/Infinity all became "null",
    // and Date/Map both became "{}".
    expect(() => canonicalJson(undefined)).toThrow(/Non-JSON value of type "undefined"/);
    expect(() => canonicalJson(NaN)).toThrow(/Non-JSON numeric value/);
    expect(() => canonicalJson(Infinity)).toThrow(/Non-JSON numeric value/);
    expect(() => canonicalJson(-Infinity)).toThrow(/Non-JSON numeric value/);
    expect(() => canonicalJson(new Date())).toThrow(/Non-plain object/);
    expect(() => canonicalJson(new Map())).toThrow(/Non-plain object/);
    expect(() => canonicalJson(new Set())).toThrow(/Non-plain object/);
    expect(() => canonicalJson(() => 1)).toThrow(/Non-JSON value of type "function"/);
    expect(() => canonicalJson(10n)).toThrow(/Non-JSON value of type "bigint"/);
    expect(() => canonicalJson({ a: undefined })).toThrow(/Non-JSON value/);
    // And the specific aliasing risk: a non-JSON value must not produce the
    // same key as an unrelated JSON value.
    expect(() => canonicalJson(new Map())).toThrow();
    expect(canonicalJson({})).toBe("{}");
  });

  it("uses ordinal ordering, not locale collation, for canonical keys", () => {
    // Canonical normalization must not vary with machine locale. Non-ASCII
    // keys and values must order by code unit deterministically.
    const first = canonicalJson({ "ä": 1, "z": 2, "a": 3 });
    const second = canonicalJson({ "z": 2, "a": 3, "ä": 1 });
    expect(first).toBe(second);
    // Under code-unit ordering "z" (U+007A) precedes "ä" (U+00E4); a
    // locale-aware collation would typically sort "ä" next to "a".
    expect(first).toBe('{"a":3,"z":2,"ä":1}');
    const values = ["ä", "z", "a"].map(item => canonicalJson({ v: item })).sort();
    expect(values).toEqual([
      canonicalJson({ v: "a" }), canonicalJson({ v: "z" }), canonicalJson({ v: "ä" }),
    ]);
  });
});

describe("unordered collection semantics", () => {
  function twoParticipantResponse(id: string) {
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal(id, [
      { unitKey: "delivery", operation: "CANCEL" },
      { unitKey: "goods_1", operation: "CANCEL" },
      { unitKey: "goods_2", operation: "CANCEL" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    return { current, quote, submitted, response };
  }

  it("accepts reordered satisfactions and requiredParticipants together", () => {
    const { current, quote, submitted, response } = twoParticipantResponse("reorder-sets");
    const shuffled = structuredClone(response.admissionReport);
    const entry = shuffled.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions || !entry.requiredParticipants) {
      throw new Error("Expected evidence and required participants");
    }
    entry.satisfactions.reverse();
    entry.requiredParticipants.reverse();
    expect(() => assertAdmissionReportWellFormed(quote, submitted, shuffled)).not.toThrow();
    expect(() => assertRetailAdmissionTrace(submitted, quote, shuffled, current.value)).not.toThrow();
  });

  it("accepts reordered collections AND reordered transition keys at once", () => {
    // The combined transformation: both the set order and the object member
    // order inside each opaque transition change.
    const { current, quote, submitted, response } = twoParticipantResponse("reorder-both");
    const shuffled = structuredClone(response.admissionReport);
    const entry = shuffled.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions || !entry.requiredParticipants) {
      throw new Error("Expected evidence and required participants");
    }
    const flip = (transition: unknown) => {
      const value = transition as { unitKey: string; operation: string };
      return { operation: value.operation, unitKey: value.unitKey };
    };
    entry.satisfactions = [...entry.satisfactions].reverse().map(item => ({
      ...item, transition: flip(item.transition),
    })) as typeof entry.satisfactions;
    entry.requiredParticipants = [...entry.requiredParticipants].reverse().map(item => ({
      ...item, transition: flip(item.transition),
    }));
    expect(() => assertAdmissionReportWellFormed(quote, submitted, shuffled)).not.toThrow();
    expect(() => assertRetailAdmissionTrace(submitted, quote, shuffled, current.value)).not.toThrow();
  });

  it("accepts reordered coverage entries", () => {
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    // Two relations at once: delivery cancel gate and goods redeem gate.
    const submitted = proposal("reorder-coverage", [
      { unitKey: "delivery", operation: "CANCEL" },
      { unitKey: "goods_1", operation: "CANCEL" },
      { unitKey: "goods_2", operation: "CANCEL" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const shuffled = structuredClone(response.admissionReport);
    shuffled.coverage.reverse();
    expect(() => assertAdmissionReportWellFormed(quote, submitted, shuffled)).not.toThrow();
    expect(() => assertRetailAdmissionTrace(submitted, quote, shuffled, current.value)).not.toThrow();
  });

  it("still detects an actual transition change under reordering", () => {
    // Reordering must not become a blanket "anything goes": a genuine
    // content change is still caught by the binding.
    const { current, quote, submitted, response } = twoParticipantResponse("reorder-but-changed");
    const tampered = structuredClone(response.admissionReport);
    const entry = tampered.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions || !entry.requiredParticipants) {
      throw new Error("Expected evidence and required participants");
    }
    entry.satisfactions.reverse();
    entry.requiredParticipants.reverse();
    // Now change one transition's CONTENT consistently in both arrays.
    const target = entry.requiredParticipants.find(
      item => item.unitLocator.unitKey === "goods_1"
    )!;
    target.transition = { unitKey: "goods_1", operation: "REDEEM" };
    const evidence = entry.satisfactions.find(
      item => "unitRef" in item &&
        quote.units.find(unit => unit.unitRef === item.unitRef)?.unitLocator.unitKey === "goods_1"
    );
    if (evidence && "transition" in evidence) {
      evidence.transition = { unitKey: "goods_1", operation: "REDEEM" };
    }
    // Core: the evidence no longer matches the quoted unit's transition.
    expect(() => assertAdmissionReportWellFormed(quote, submitted, tampered)).toThrow();
    // Binding: contradicts the real evaluation regardless.
    expect(() => assertRetailAdmissionTrace(submitted, quote, tampered, current.value)).toThrow();
  });

  it("accepts a realization report whose entries are reordered", () => {
    const { quote, submitted, response } = twoParticipantResponse("reorder-realization");
    const derived = deriveSatisfactionRealization(
      response.admissionReport, response.commitResult
    );
    expect(derived.entries.length).toBeGreaterThan(1);
    const shuffled = { ...derived, entries: [...derived.entries].reverse() };
    expect(() => assertSatisfactionRealizationConsistent(
      response.admissionReport, response.commitResult, shuffled
    )).not.toThrow();
    void quote; void submitted;
  });
});

describe("scope of the realization aggregate", () => {
  it("counts only relations that supplied evidence, not every gate", () => {
    // A cancel gate on an order with no GOODS units declares no
    // passEvidence, so its PASSED carries no satisfaction records and
    // contributes no realization entry at all.
    const current = { value: {
      orderId: "order_799", version: 1,
      units: { delivery: { kind: "DELIVERY" as const, state: "COMMITTED" as const } },
    } };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("evidence-free", [{ unitKey: "delivery", operation: "CANCEL" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");

    const passed = response.admissionReport.coverage[0];
    expect(passed.status).toBe("PASSED");
    if (passed.status !== "PASSED") throw new Error("Expected PASSED");
    expect(passed.satisfactions).toBeUndefined();

    // The gate passed, yet there is nothing to realize: zero entries, and
    // the non-vacuous rule reports false.
    const realization = assertCommitResponseWellFormed(quote, submitted, response);
    expect(realization?.entries).toEqual([]);
    expect(realization?.allRealized).toBe(false);
  });

  it("aggregates over present entries only when evidence-bearing and evidence-free mix", () => {
    // Hand-built report: one evidence-bearing relation that realizes, and
    // one PASSED relation with no satisfaction records. allRealized is true
    // and says NOTHING about the second relation. This is the documented
    // scope, so the test states it explicitly rather than implying the
    // aggregate covers every gate.
    const report = {
      quoteId: "q", proposalId: "p", evaluatedAt: "2026-09-18T00:00:00Z", failures: [],
      coverage: [
        {
          relationId: "rel_with_evidence",
          status: "PASSED",
          requiredParticipants: [
            { unitLocator: { scopeRef: "s", unitKey: "X" }, transition: { op: "A" } },
          ],
          satisfactions: [
            { source: "CURRENT_REQUEST", unitRef: "u_x", transition: { op: "A" } },
          ],
        },
        { relationId: "rel_without_evidence", status: "PASSED" },
      ],
    } as unknown as AdmissionReport;
    const result = {
      quoteId: "q",
      unitResults: [{ unitRef: "u_x", outcome: "APPLIED", committedEffects: [] }],
    } as unknown as CommitResult;

    const realization = deriveSatisfactionRealization(report, result);
    expect(realization.entries).toHaveLength(1);
    expect(realization.entries[0].relationId).toBe("rel_with_evidence");
    expect(realization.allRealized).toBe(true);
    // Documented meaning: the evidence-free relation is absent from the
    // aggregate entirely. `true` is not a claim about it.
    expect(realization.entries.some(item => item.relationId === "rel_without_evidence"))
      .toBe(false);
  });

  it("keeps historical-A and current-B on one unit distinguishable when correlated", () => {
    // A realization entry is not self-describing: it omits the transition.
    // It stays unambiguous because (relationId, source, participant) is
    // unique within a report.
    const report = {
      quoteId: "q", proposalId: "p", evaluatedAt: "2026-09-18T00:00:00Z", failures: [],
      coverage: [
        {
          relationId: "rel_hist",
          status: "PASSED",
          requiredParticipants: [
            { unitLocator: { scopeRef: "s", unitKey: "X" }, transition: { op: "A" } },
          ],
          satisfactions: [{
            source: "PRIOR_FINAL_TRANSITION",
            unitLocator: { scopeRef: "s", unitKey: "X" },
            transition: { op: "A" },
            transitionRef: "h1",
            finalizedAt: "2026-09-01T00:00:00Z",
          }],
        },
        {
          relationId: "rel_curr",
          status: "PASSED",
          requiredParticipants: [
            { unitLocator: { scopeRef: "s", unitKey: "X" }, transition: { op: "B" } },
          ],
          satisfactions: [{ source: "CURRENT_REQUEST", unitRef: "u_x", transition: { op: "B" } }],
        },
      ],
    } as unknown as AdmissionReport;
    const result = {
      quoteId: "q",
      unitResults: [{ unitRef: "u_x", outcome: "REFUSED", refusalReason: "CONSTRAINT_VIOLATED" }],
    } as unknown as CommitResult;

    const realization = deriveSatisfactionRealization(report, result);
    const historical = realization.entries.find(item => item.relationId === "rel_hist")!;
    const currentEntry = realization.entries.find(item => item.relationId === "rel_curr")!;
    // Same domain unit, opposite verdicts, no ambiguity.
    expect(historical.source).toBe("PRIOR_FINAL_TRANSITION");
    expect(historical.realization).toBe("REALIZED");
    expect(currentEntry.source).toBe("CURRENT_REQUEST");
    expect(currentEntry.realization).toBe("NOT_REALIZED");
    expect(realization.allRealized).toBe(false);
    // Joining on (relationId, source, participant) recovers each transition
    // from the originating report.
    const joined = report.coverage.find(item => item.relationId === historical.relationId);
    if (joined?.status !== "PASSED") throw new Error("Expected PASSED");
    expect(joined.satisfactions?.[0].transition).toEqual({ op: "A" });
  });
});

describe("retail trace comparator as a correctness boundary", () => {
  function historicalState() {
    return { value: orderState({
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
  }

  it("rejects false PRIOR_FINAL history the core cannot disprove", () => {
    // No delivery history at all in real state; the producer invents one.
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("false-history", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
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
    if (entry.status !== "PASSED") throw new Error("Expected PASSED");
    const invented = { unitKey: "delivery", operation: "CANCEL" };
    entry.satisfactions = [{
      source: "PRIOR_FINAL_TRANSITION",
      unitLocator: { scopeRef: "retail:order_799", unitKey: "delivery" },
      transition: invented,
      transitionRef: "never-happened",
      finalizedAt: "2026-09-01T00:00:00Z",
    }];
    entry.requiredParticipants = [{
      unitLocator: { scopeRef: "retail:order_799", unitKey: "delivery" },
      transition: invented,
    }];
    // Internally coherent, so core accepts. The binding re-reads real
    // history and rejects.
    expect(() => assertAdmissionReportWellFormed(quote, submitted, forged)).not.toThrow();
    expect(() => assertRetailAdmissionTrace(submitted, quote, forged, current.value))
      .toThrow(/contradicts the retail binding evaluation trace/);
  });

  it("evaluates genuine prior A plus different current B by retail semantics", () => {
    // delivery has genuine prior REDEEM history AND the request carries a
    // different current transition on delivery (CANCEL). The locator
    // repeats, which must not by itself decide the outcome; the retail
    // gates decide.
    const current = historicalState();
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("prior-a-current-b", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "CANCEL" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] },
      new Date("2026-09-02T00:00:00Z")
    );
    // Whatever the retail gates decide, the binding's own trace must agree
    // with its own evaluation: it is not rejected merely for the repeat.
    const report = response.kind === "COMMIT_RESULT"
      ? response.admissionReport
      : response.admissionRefusal;
    expect(() => assertRetailAdmissionTrace(submitted, quote, report, current.value))
      .not.toThrow();
  });
});

describe("reconciliation updates realization for an indeterminate satisfier", () => {
  it("moves a satisfier from INDETERMINATE to REALIZED after reconciliation", () => {
    const current = { value: orderState() };
    let resolve: "APPLIED" | "REFUSED" | undefined;
    const { provider, syncSnapshot } = configuredProvider(current, undefined, {
      shouldTimeout: (_request, _quote, unit) => unit.unitLocator.unitKey === "delivery",
      reconciliationOutcome: () => resolve,
    });
    const submitted = proposal("reconcile-realization", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const delivery = quote.units.find(unit => unit.unitLocator.unitKey === "delivery")!;
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");

    // Before reconciliation the satisfier is indeterminate.
    const before = provider.satisfactionRealization(quote.quoteId);
    expect(before?.entries.find(item => item.unitRef === delivery.unitRef)?.realization)
      .toBe("INDETERMINATE");
    expect(before?.allRealized).toBe(false);

    const indeterminate = response.commitResult.unitResults.find(
      item => item.unitRef === delivery.unitRef
    );
    if (indeterminate?.outcome !== "INDETERMINATE") throw new Error("Expected INDETERMINATE");
    const correlationId = indeterminate.reconciliation.correlationId!;

    // Reconciliation discovers it actually applied.
    resolve = "APPLIED";
    expect(provider.reconcile(correlationId)).toBe("APPLIED");

    const after = provider.satisfactionRealization(quote.quoteId);
    expect(after?.entries.find(item => item.unitRef === delivery.unitRef)?.realization)
      .toBe("REALIZED");
    expect(after?.allRealized).toBe(true);
  });

  it("moves a satisfier to NOT_REALIZED when reconciliation discovers refusal", () => {
    const current = { value: orderState() };
    let resolve: "APPLIED" | "REFUSED" | undefined;
    const { provider, syncSnapshot } = configuredProvider(current, undefined, {
      shouldTimeout: (_request, _quote, unit) => unit.unitLocator.unitKey === "delivery",
      reconciliationOutcome: () => resolve,
    });
    const submitted = proposal("reconcile-refused", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const delivery = quote.units.find(unit => unit.unitLocator.unitKey === "delivery")!;
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const indeterminate = response.commitResult.unitResults.find(
      item => item.unitRef === delivery.unitRef
    );
    if (indeterminate?.outcome !== "INDETERMINATE") throw new Error("Expected INDETERMINATE");

    resolve = "REFUSED";
    expect(provider.reconcile(indeterminate.reconciliation.correlationId!)).toBe("REFUSED");

    const after = provider.satisfactionRealization(quote.quoteId);
    expect(after?.entries.find(item => item.unitRef === delivery.unitRef)?.realization)
      .toBe("NOT_REALIZED");
    expect(after?.allRealized).toBe(false);
  });
});

describe("trace comparator resists set-normalization attacks", () => {
  function cancelResponse(id: string) {
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal(id, [
      { unitKey: "delivery", operation: "CANCEL" },
      { unitKey: "goods_1", operation: "CANCEL" },
      { unitKey: "goods_2", operation: "CANCEL" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    return { current, quote, submitted, response };
  }

  it("rejects a duplicated satisfaction despite membership normalization", () => {
    // Sorting for set comparison must not collapse duplicates into one.
    const { current, quote, submitted, response } = cancelResponse("dup-sat");
    const forged = structuredClone(response.admissionReport);
    const entry = forged.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    entry.satisfactions.push(structuredClone(entry.satisfactions[0]));
    expect(() => assertRetailAdmissionTrace(submitted, quote, forged, current.value)).toThrow();
    // Core rejects it too, as a duplicate participant.
    expect(() => assertAdmissionReportWellFormed(quote, submitted, forged))
      .toThrow(/Duplicate satisfaction evidence/);
  });

  it("rejects a duplicated required participant", () => {
    const { current, quote, submitted, response } = cancelResponse("dup-part");
    const forged = structuredClone(response.admissionReport);
    const entry = forged.coverage[0];
    if (entry.status !== "PASSED" || !entry.requiredParticipants) {
      throw new Error("Expected required participants");
    }
    entry.requiredParticipants.push(structuredClone(entry.requiredParticipants[0]));
    expect(() => assertRetailAdmissionTrace(submitted, quote, forged, current.value)).toThrow();
    expect(() => assertAdmissionReportWellFormed(quote, submitted, forged))
      .toThrow(/repeats required participant/);
  });

  it("rejects an extra coverage entry for an undeclared relation", () => {
    const { current, quote, submitted, response } = cancelResponse("extra-coverage");
    const forged = structuredClone(response.admissionReport);
    forged.coverage.push({ relationId: "retail:invented", status: "PASSED" });
    expect(() => assertRetailAdmissionTrace(submitted, quote, forged, current.value)).toThrow();
    expect(() => assertAdmissionReportWellFormed(quote, submitted, forged))
      .toThrow(/undeclared coverage relation/);
  });

  it("rejects a forged stateRef that misdescribes the evaluated state", () => {
    // Pre-repair gap: the comparator never compared stateRef, so a report
    // could claim it was evaluated against a different order version and
    // still pass trace conformance. Core cannot catch this: stateRef is
    // opaque evidence it does not interpret.
    const { current, quote, submitted, response } = cancelResponse("forged-stateref");
    const forged = structuredClone(response.admissionReport);
    expect(forged.stateRef).toEqual({ orderVersion: 1 });
    forged.stateRef = { orderVersion: 9999 };
    expect(() => assertAdmissionReportWellFormed(quote, submitted, forged)).not.toThrow();
    expect(() => assertRetailAdmissionTrace(submitted, quote, forged, current.value))
      .toThrow(/contradicts the retail binding evaluation trace/);
  });

  it("accepts a stateRef whose object members are merely reordered", () => {
    // Opaque value: member order is not a contradiction.
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("stateref-order", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const reordered = structuredClone(response.admissionReport);
    reordered.stateRef = { orderVersion: 1 };
    expect(() => assertRetailAdmissionTrace(submitted, quote, reordered, current.value))
      .not.toThrow();
  });
});

describe("retail prior-final selection respects evaluation time", () => {
  const evaluatedAt = new Date("2026-09-10T00:00:00Z");
  const finalAt = (transitionRef: string, finalizedAt: string) => ({
    status: "FINAL" as const,
    transitionRef,
    transition: { unitKey: "delivery", operation: "REDEEM" as const },
    finalizedAt,
  });

  function evaluate(id: string, history: ReturnType<typeof finalAt>[]) {
    const current = { value: orderState({
      delivery: { kind: "DELIVERY", state: "REDEEMED", transitionHistory: history },
    }) };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal(id, [{ unitKey: "goods_1", operation: "REDEEM" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] }, evaluatedAt
    );
    return { current, quote, submitted, response };
  }

  const citedRef = (response: ReturnType<ReferenceProvider["commit"]>) => {
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const entry = response.admissionReport.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    const record = entry.satisfactions[0];
    if (record.source !== "PRIOR_FINAL_TRANSITION") throw new Error("Expected prior-final");
    return record.transitionRef;
  };

  it("uses a FINAL record finalized before the evaluation instant", () => {
    const { current, quote, submitted, response } = evaluate(
      "past", [finalAt("past", "2026-09-01T00:00:00Z")]
    );
    expect(citedRef(response)).toBe("past");
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    expect(() => assertRetailAdmissionTrace(
      submitted, quote, response.admissionReport, current.value
    )).not.toThrow();
  });

  it("uses a FINAL record finalized exactly at the evaluation instant", () => {
    const { response } = evaluate("boundary", [finalAt("boundary", "2026-09-10T00:00:00Z")]);
    expect(citedRef(response)).toBe("boundary");
  });

  it("does not use a FINAL record finalized after the evaluation instant", () => {
    // Previously this was emitted as evidence and then crashed core
    // validation on finalizedAt > evaluatedAt. It must instead take the
    // ordinary failure path.
    const { response } = evaluate("future", [finalAt("future", "2026-09-20T00:00:00Z")]);
    expect(response.kind).toBe("ADMISSION_REFUSED");
    if (response.kind !== "ADMISSION_REFUSED") throw new Error("Expected refusal");
    const witness = response.admissionRefusal.failures[0].witness;
    expect(witness.disposition).toBe("COMPLETE");
  });

  it("selects a valid record that a future-dated earlier element would hide", () => {
    const { response } = evaluate("ordering", [
      finalAt("future", "2026-09-20T00:00:00Z"),
      finalAt("valid", "2026-09-01T00:00:00Z"),
    ]);
    expect(citedRef(response)).toBe("valid");
  });

  it("selects deterministically regardless of history array order", () => {
    // Two qualifying records: latest finalization wins, independent of the
    // order they appear in history.
    const forward = evaluate("det-forward", [
      finalAt("older", "2026-09-01T00:00:00Z"),
      finalAt("newer", "2026-09-05T00:00:00Z"),
    ]);
    const reversed = evaluate("det-reversed", [
      finalAt("newer", "2026-09-05T00:00:00Z"),
      finalAt("older", "2026-09-01T00:00:00Z"),
    ]);
    expect(citedRef(forward.response)).toBe("newer");
    expect(citedRef(reversed.response)).toBe("newer");
  });

  it("takes the normal failure path when no history is temporally valid", () => {
    const { response } = evaluate("none-valid", [
      finalAt("f1", "2026-09-20T00:00:00Z"),
      finalAt("f2", "2026-09-30T00:00:00Z"),
    ]);
    expect(response.kind).toBe("ADMISSION_REFUSED");
  });
});

describe("allRealized summarizes satisfaction entries, not commit success", () => {
  it("reports allRealized true while every unit is REFUSED by quote expiry", () => {
    // The sharpest demonstration of the aggregate's scope. Admission is
    // satisfied entirely by legitimate PRIOR_FINAL history, then the quote
    // expires before dispatch, so nothing commits. The historical
    // satisfaction really did happen, so it is REALIZED; the commit
    // entirely failed. Both statements are true at once.
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
    const { provider, syncSnapshot, dispatchCount } = configuredProvider(current);
    const submitted = proposal("historical-then-expired", [
      { unitKey: "goods_1", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    quote.expiresAt = "2026-09-02T00:00:00Z";
    syncSnapshot();
    const response = provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] },
      new Date("2026-09-03T00:00:00Z")
    );
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");

    // Admission passed on purely historical evidence.
    const entry = response.admissionReport.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    expect(entry.satisfactions[0].source).toBe("PRIOR_FINAL_TRANSITION");

    // Execution refused everything.
    expect(response.commitResult.unitResults.every(
      item => item.outcome === "REFUSED" && item.refusalReason === "QUOTE_EXPIRED"
    )).toBe(true);
    expect(response.commitResult.aggregateHint).toBe("ALL_REFUSED");
    expect(dispatchCount()).toBe(0);

    // And the satisfaction aggregate is true, because the one satisfaction
    // present is historical and did occur. This is the intended meaning:
    // `allRealized` says nothing about whether the commit succeeded. A
    // reader wanting that must read `unitResults` or `aggregateHint`.
    const realization = assertCommitResponseWellFormed(quote, submitted, response);
    expect(realization?.entries).toHaveLength(1);
    expect(realization?.entries[0].realization).toBe("REALIZED");
    expect(realization?.allRealized).toBe(true);

    // The two summaries deliberately disagree, and both are correct.
    expect(response.commitResult.aggregateHint).toBe("ALL_REFUSED");
    expect(realization?.allRealized).toBe(true);
  });
});

describe("trace comparator permutation matrix", () => {
  it("accepts reordered dependsOn in a DEFERRED entry", () => {
    // DEFERRED dependsOn is a set of relation identities (spec §3.2).
    const quote: MutationQuote = {
      quoteId: "q", target: {}, units: [
        { unitRef: "u1", unitLocator: { scopeRef: "s", unitKey: "a" },
          transition: { op: "X" }, effects: [] },
      ],
      admissionRelations: [
        { relationId: "r_a", type: "REQUIRES_COINCLUSION", triggerUnitRefs: ["u1"], scopeRef: "s" },
        { relationId: "r_b", type: "REQUIRES_COINCLUSION", triggerUnitRefs: ["u1"], scopeRef: "s" },
        { relationId: "r_c", type: "REQUIRES_COINCLUSION", triggerUnitRefs: ["u1"], scopeRef: "s" },
      ],
    };
    const failures = [
      { relationId: "r_a", witness: { disposition: "UNAVAILABLE" as const } },
      { relationId: "r_b", witness: { disposition: "UNAVAILABLE" as const } },
    ];
    const forward = [
      { relationId: "r_a", status: "FAILED" as const },
      { relationId: "r_b", status: "FAILED" as const },
      { relationId: "r_c", status: "DEFERRED" as const, dependsOn: ["r_a", "r_b"] },
    ];
    const reversed = [
      { relationId: "r_c", status: "DEFERRED" as const, dependsOn: ["r_b", "r_a"] },
      { relationId: "r_b", status: "FAILED" as const },
      { relationId: "r_a", status: "FAILED" as const },
    ];
    expect(() => assertAdmissionCoverageWellFormed(quote, failures, forward)).not.toThrow();
    expect(() => assertAdmissionCoverageWellFormed(quote, failures, reversed)).not.toThrow();
  });

  it("accepts a reordered COMPLETE witness requiredTransitions list", () => {
    // requiredTransitions names what is missing, not an order to add it in.
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("witness-order", [{ unitKey: "delivery", operation: "CANCEL" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "ADMISSION_REFUSED") throw new Error("Expected refusal");
    const permuted = structuredClone(response.admissionRefusal);
    const witness = permuted.failures[0].witness;
    if (witness.disposition !== "COMPLETE") throw new Error("Expected COMPLETE");
    expect(witness.requiredTransitions).toHaveLength(2);
    witness.requiredTransitions.reverse();
    expect(() => assertRetailAdmissionTrace(submitted, quote, permuted, current.value))
      .not.toThrow();
    expect(() => assertAdmissionRefusalWellFormed(quote, submitted, permuted)).not.toThrow();
  });

  it("preserves cardinality: a duplicate inside a nested set still differs", () => {
    // Normalization sorts, it never deduplicates.
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("cardinality", [{ unitKey: "delivery", operation: "CANCEL" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "ADMISSION_REFUSED") throw new Error("Expected refusal");
    const duplicated = structuredClone(response.admissionRefusal);
    const witness = duplicated.failures[0].witness;
    if (witness.disposition !== "COMPLETE") throw new Error("Expected COMPLETE");
    witness.requiredTransitions.push(structuredClone(witness.requiredTransitions[0]));
    expect(() => assertRetailAdmissionTrace(submitted, quote, duplicated, current.value))
      .toThrow(/contradicts the retail binding evaluation trace/);
  });

  it("accepts outer and inner permutation applied together", () => {
    // Coverage order, satisfaction order, participant order, and object
    // member order inside each transition all changed at once.
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("full-permutation", [
      { unitKey: "delivery", operation: "CANCEL" },
      { unitKey: "goods_1", operation: "CANCEL" },
      { unitKey: "goods_2", operation: "CANCEL" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const permuted = structuredClone(response.admissionReport);
    permuted.coverage.reverse();
    const flip = (transition: unknown) => {
      const value = transition as { unitKey: string; operation: string };
      return { operation: value.operation, unitKey: value.unitKey };
    };
    for (const entry of permuted.coverage) {
      if (entry.status !== "PASSED") continue;
      if (entry.satisfactions) {
        entry.satisfactions = [...entry.satisfactions].reverse().map(item => ({
          ...item, transition: flip(item.transition),
        })) as typeof entry.satisfactions;
      }
      if (entry.requiredParticipants) {
        entry.requiredParticipants = [...entry.requiredParticipants].reverse().map(item => ({
          ...item, transition: flip(item.transition),
        }));
      }
    }
    expect(() => assertAdmissionReportWellFormed(quote, submitted, permuted)).not.toThrow();
    expect(() => assertRetailAdmissionTrace(submitted, quote, permuted, current.value))
      .not.toThrow();
  });

  it("accepts equivalent finalizedAt spellings in trace conformance", () => {
    // Core compares this field as an instant; the binding must agree.
    const current = { value: orderState({
      delivery: {
        kind: "DELIVERY", state: "REDEEMED",
        transitionHistory: [{
          status: "FINAL" as const,
          transitionRef: "h",
          transition: { unitKey: "delivery", operation: "REDEEM" as const },
          finalizedAt: "2026-09-18T12:00:00Z",
        }],
      },
    }) };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("tz-spelling", [{ unitKey: "goods_1", operation: "REDEEM" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] },
      new Date("2026-09-19T00:00:00Z")
    );
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    const respelled = structuredClone(response.admissionReport);
    const entry = respelled.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    const record = entry.satisfactions[0];
    if (record.source !== "PRIOR_FINAL_TRANSITION") throw new Error("Expected prior-final");
    expect(Date.parse("2026-09-18T05:00:00-07:00")).toBe(Date.parse(record.finalizedAt));
    record.finalizedAt = "2026-09-18T05:00:00-07:00";
    expect(() => assertRetailAdmissionTrace(submitted, quote, respelled, current.value))
      .not.toThrow();
    // A genuinely different instant still differs.
    record.finalizedAt = "2026-09-17T12:00:00Z";
    expect(() => assertRetailAdmissionTrace(submitted, quote, respelled, current.value))
      .toThrow(/contradicts the retail binding evaluation trace/);
  });
});

describe("cost of Model B: laundering is binding-owned", () => {
  it("core accepts a refused current satisfier relabelled as its own history", () => {
    // Honest record of what Model B gives up. The pair rule blocked exactly
    // this shape. It is removed because the rule rested on an unproven
    // premise -- that (locator, transition) identifies an occurrence -- and
    // so falsely rejected truthful reports about repeatable operations.
    //
    // The security value given up is small: the prior pass already showed a
    // forger can cite a DIFFERENT transition value and defeat the pair rule
    // anyway. So the rule blocked one spelling of an attack that has
    // unlimited spellings, while rejecting legitimate reports. Both the
    // laundered and the different-transition variants are rejected by the
    // same mechanism: binding trace conformance authenticating history.
    //
    // Core acceptance here is EXPECTED, not a safety claim. Core validates
    // structure — source shape, scope, transition correspondence, timestamp
    // format and ordering — and nothing in that set can distinguish a real
    // occurrence from an invented one. Only the binding, holding the unit's
    // history, can resolve the cited transitionRef. A reader must therefore
    // never treat "core accepted this prior-final record" as evidence the
    // history happened.
    const current = { value: orderState() };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("laundered", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const delivery = quote.units.find(unit => unit.unitLocator.unitKey === "delivery")!;
    const response = provider.commit(
      {
        quoteId: quote.quoteId,
        acceptanceConstraints: [{
          effectId: delivery.effects[0].effectId,
          operator: "<=",
          value: { type: "money", amount: "-1.00", currency: "USD" },
        }],
      },
      new Date("2026-09-02T00:00:00Z")
    );
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    expect(response.commitResult.unitResults.find(item => item.unitRef === delivery.unitRef)
      ?.outcome).toBe("REFUSED");

    const laundered = structuredClone(response.admissionReport);
    const entry = laundered.coverage[0];
    if (entry.status !== "PASSED") throw new Error("Expected PASSED");
    entry.satisfactions = [{
      source: "PRIOR_FINAL_TRANSITION",
      unitLocator: { scopeRef: "retail:order_799", unitKey: "delivery" },
      transition: { unitKey: "delivery", operation: "REDEEM" },
      transitionRef: "claimed-earlier-occurrence",
      finalizedAt: "2026-09-01T00:00:00Z",
    }];

    // Core accepts, and realization reports the historical claim realized.
    expect(() => assertCommitResponseWellFormed(quote, submitted, {
      ...response, admissionReport: laundered,
    })).not.toThrow();
    expect(deriveSatisfactionRealization(laundered, response.commitResult).allRealized).toBe(true);

    // The binding rejects it: no such occurrence exists in real history.
    expect(() => assertRetailAdmissionTrace(submitted, quote, laundered, current.value))
      .toThrow(/contradicts the retail binding evaluation trace/);
  });
});

/**
 * Retail evidence-source precedence, transitionRef identity, and canonical
 * historical selection. These are binding contracts, not generic MSE rules.
 */
describe("retail evidence-source precedence", () => {
  const priorRedeem = (transitionRef = "h1", finalizedAt = "2026-09-01T00:00:00Z") => ({
    status: "FINAL" as const,
    transitionRef,
    transition: { unitKey: "delivery", operation: "REDEEM" as const },
    finalizedAt,
  });
  const evaluatedAt = new Date("2026-09-10T00:00:00Z");

  function redeemWith(
    id: string,
    history: RetailOrderState["units"]["delivery"]["transitionHistory"],
    options: { refuseDelivery?: boolean; timeoutDelivery?: boolean } = {}
  ) {
    const current = { value: orderState({
      delivery: { kind: "DELIVERY", state: "COMMITTED", transitionHistory: history },
    }) };
    const fault = options.timeoutDelivery
      ? {
          shouldTimeout: (
            _request: { quoteId: string },
            _quote: MutationQuote,
            unit: { unitLocator: { unitKey: string } }
          ) => unit.unitLocator.unitKey === "delivery",
        }
      : {};
    const { provider, syncSnapshot } = configuredProvider(
      current, undefined, fault as ConstructorParameters<typeof ReferenceProvider>[2]
    );
    const submitted = proposal(id, [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const delivery = quote.units.find(unit => unit.unitLocator.unitKey === "delivery")!;
    const response = provider.commit({
      quoteId: quote.quoteId,
      acceptanceConstraints: options.refuseDelivery
        ? [{
            effectId: delivery.effects[0].effectId,
            operator: "<=" as const,
            value: { type: "money" as const, amount: "-1.00", currency: "USD" },
          }]
        : [],
    }, evaluatedAt);
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    return { current, quote, submitted, response, delivery };
  }

  const citedSource = (response: Extract<ReturnType<ReferenceProvider["commit"]>,
    { kind: "COMMIT_RESULT" }>) => {
    const entry = response.admissionReport.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    return entry.satisfactions[0].source;
  };

  it("prefers prior-final evidence when the current attempt is APPLIED", () => {
    const { current, quote, submitted, response, delivery } = redeemWith(
      "prec-applied", [priorRedeem()]
    );
    expect(citedSource(response)).toBe("PRIOR_FINAL_TRANSITION");
    expect(response.commitResult.unitResults.find(item => item.unitRef === delivery.unitRef)
      ?.outcome).toBe("APPLIED");
    const realization = assertCommitResponseWellFormed(quote, submitted, response);
    expect(realization?.entries[0].realization).toBe("REALIZED");
    expect(() => assertRetailAdmissionTrace(
      submitted, quote, response.admissionReport, current.value
    )).not.toThrow();
  });

  it("keeps realization REALIZED when the redundant current attempt is REFUSED", () => {
    // The case the precedence rule exists for. The relation was already
    // satisfied historically, so a refused redundant attempt must not make
    // the admission read as unrealized.
    const { current, quote, submitted, response, delivery } = redeemWith(
      "prec-refused", [priorRedeem()], { refuseDelivery: true }
    );
    expect(citedSource(response)).toBe("PRIOR_FINAL_TRANSITION");
    expect(response.commitResult.unitResults.find(item => item.unitRef === delivery.unitRef)
      ?.outcome).toBe("REFUSED");
    const realization = assertCommitResponseWellFormed(quote, submitted, response);
    expect(realization?.entries[0].realization).toBe("REALIZED");
    expect(realization?.allRealized).toBe(true);
    expect(() => assertRetailAdmissionTrace(
      submitted, quote, response.admissionReport, current.value
    )).not.toThrow();
  });

  it("keeps realization REALIZED when the redundant current attempt is INDETERMINATE", () => {
    const { quote, submitted, response, delivery } = redeemWith(
      "prec-indeterminate", [priorRedeem()], { timeoutDelivery: true }
    );
    expect(citedSource(response)).toBe("PRIOR_FINAL_TRANSITION");
    expect(response.commitResult.unitResults.find(item => item.unitRef === delivery.unitRef)
      ?.outcome).toBe("INDETERMINATE");
    const realization = assertCommitResponseWellFormed(quote, submitted, response);
    expect(realization?.entries[0].realization).toBe("REALIZED");
  });

  it("uses current-request evidence when no prior occurrence exists", () => {
    const { response } = redeemWith("prec-no-prior", undefined);
    expect(citedSource(response)).toBe("CURRENT_REQUEST");
  });

  it("uses current-request evidence when prior history does not satisfy the relation", () => {
    // A prior CANCEL exists, but the redeem gate needs a prior REDEEM.
    const { current, quote, submitted, response } = redeemWith("prec-insufficient", [{
      status: "FINAL" as const,
      transitionRef: "h-cancel",
      transition: { unitKey: "delivery", operation: "CANCEL" as const },
      finalizedAt: "2026-09-01T00:00:00Z",
    }]);
    expect(citedSource(response)).toBe("CURRENT_REQUEST");
    expect(() => assertRetailAdmissionTrace(
      submitted, quote, response.admissionReport, current.value
    )).not.toThrow();
  });
});

describe("retail transitionRef identity", () => {
  const evaluatedAt = new Date("2026-09-10T00:00:00Z");
  function commitWith(id: string, history: unknown[]) {
    const current = { value: orderState({
      delivery: {
        kind: "DELIVERY", state: "REDEEMED",
        transitionHistory: history as RetailOrderState["units"]["delivery"]["transitionHistory"],
      },
    }) };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal(id, [{ unitKey: "goods_1", operation: "REDEEM" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    return () => provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] }, evaluatedAt);
  }

  it("rejects a duplicate transitionRef carrying a different transition", () => {
    const commit = commitWith("dup-transition", [
      { status: "FINAL", transitionRef: "same",
        transition: { unitKey: "delivery", operation: "REDEEM" },
        finalizedAt: "2026-09-01T00:00:00Z" },
      { status: "FINAL", transitionRef: "same",
        transition: { unitKey: "delivery", operation: "CANCEL" },
        finalizedAt: "2026-09-02T00:00:00Z" },
    ]);
    expect(() => commit()).toThrow(/reuses transitionRef "same"/);
  });

  it("rejects a duplicate transitionRef carrying a different finalizedAt", () => {
    const commit = commitWith("dup-time", [
      { status: "FINAL", transitionRef: "same",
        transition: { unitKey: "delivery", operation: "REDEEM" },
        finalizedAt: "2026-09-01T00:00:00Z" },
      { status: "FINAL", transitionRef: "same",
        transition: { unitKey: "delivery", operation: "REDEEM" },
        finalizedAt: "2026-09-02T00:00:00Z" },
    ]);
    expect(() => commit()).toThrow(/reuses transitionRef "same"/);
  });

  it("rejects an exact duplicate historical record", () => {
    const record = {
      status: "FINAL", transitionRef: "same",
      transition: { unitKey: "delivery", operation: "REDEEM" },
      finalizedAt: "2026-09-01T00:00:00Z",
    };
    const commit = commitWith("dup-exact", [record, structuredClone(record)]);
    expect(() => commit()).toThrow(/reuses transitionRef "same"/);
  });

  it("allows the same transitionRef on a different unit", () => {
    // Scope is (unitLocator, transitionRef). The core protocol does not
    // declare transitionRef globally scoped, so cross-unit reuse is fine.
    const current = { value: orderState({
      goods_1: {
        kind: "GOODS", state: "CANCELLED",
        transitionHistory: [{
          status: "FINAL" as const, transitionRef: "shared",
          transition: { unitKey: "goods_1", operation: "CANCEL" as const },
          finalizedAt: "2026-09-01T00:00:00Z",
        }],
      },
      goods_2: {
        kind: "GOODS", state: "CANCELLED",
        transitionHistory: [{
          status: "FINAL" as const, transitionRef: "shared",
          transition: { unitKey: "goods_2", operation: "CANCEL" as const },
          finalizedAt: "2026-09-01T00:00:00Z",
        }],
      },
    }) };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("cross-unit-ref", [{ unitKey: "delivery", operation: "CANCEL" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    expect(() => provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] }, new Date("2026-09-10T00:00:00Z")
    )).not.toThrow();
  });
});

describe("retail historical timestamp qualification matches core", () => {
  const evaluatedAt = new Date("2026-09-10T00:00:00Z");
  function selectedRef(id: string, finalizedAt: string) {
    const current = { value: orderState({
      delivery: {
        kind: "DELIVERY", state: "REDEEMED",
        transitionHistory: [{
          status: "FINAL" as const, transitionRef: "candidate",
          transition: { unitKey: "delivery", operation: "REDEEM" as const },
          finalizedAt,
        }],
      },
    }) };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal(id, [{ unitKey: "goods_1", operation: "REDEEM" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] }, evaluatedAt
    );
    if (response.kind === "ADMISSION_REFUSED") return null;
    const entry = response.admissionReport.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    return entry.satisfactions[0];
  }

  it("accepts a valid Z timestamp", () => {
    expect(selectedRef("iso-z", "2026-09-01T00:00:00Z")).not.toBeNull();
  });

  it("accepts a valid offset timestamp", () => {
    expect(selectedRef("iso-offset", "2026-08-31T17:00:00-07:00")).not.toBeNull();
  });

  it("treats equivalent Z and offset spellings as the same instant", () => {
    const zForm = selectedRef("equiv-z", "2026-09-01T00:00:00Z");
    const offsetForm = selectedRef("equiv-offset", "2026-08-31T17:00:00-07:00");
    if (!zForm || !offsetForm) throw new Error("Expected both to qualify");
    if (zForm.source !== "PRIOR_FINAL_TRANSITION") throw new Error("Expected prior-final");
    if (offsetForm.source !== "PRIOR_FINAL_TRANSITION") throw new Error("Expected prior-final");
    expect(Date.parse(zForm.finalizedAt)).toBe(Date.parse(offsetForm.finalizedAt));
  });

  it("rejects a date-only string that bare Date.parse would accept", () => {
    // The specific hazard: "2026-09-01" parses in JavaScript but is not an
    // ISO date-time, so selecting it would emit evidence core rejects.
    expect(Number.isNaN(Date.parse("2026-09-01"))).toBe(false);
    expect(selectedRef("date-only", "2026-09-01")).toBeNull();
  });

  it("rejects a malformed offset", () => {
    expect(selectedRef("bad-offset", "2026-09-01T00:00:00+7:00")).toBeNull();
  });

  it("rejects an impossible date that fails the format contract", () => {
    expect(selectedRef("impossible-month", "2026-13-01T00:00:00Z")).toBeNull();
    expect(selectedRef("impossible-hour", "2026-09-01T25:00:00Z")).toBeNull();
  });

  it("rejects a future-dated record and accepts one exactly at evaluation", () => {
    expect(selectedRef("future", "2026-09-20T00:00:00Z")).toBeNull();
    expect(selectedRef("exact", "2026-09-10T00:00:00Z")).not.toBeNull();
  });
});

describe("trace oracle resolves transitionRef to the exact occurrence", () => {
  function historicalOrder(id: string) {
    const current = { value: orderState({
      goods_2: {
        kind: "GOODS", state: "CANCELLED",
        transitionHistory: [{
          status: "FINAL" as const, transitionRef: "g2-cancel",
          transition: { unitKey: "goods_2", operation: "CANCEL" as const },
          finalizedAt: "2026-09-01T00:00:00Z",
        }],
      },
      delivery: {
        kind: "DELIVERY", state: "REDEEMED",
        transitionHistory: [{
          status: "FINAL" as const, transitionRef: "d-redeem",
          transition: { unitKey: "delivery", operation: "REDEEM" as const },
          finalizedAt: "2026-09-01T00:00:00Z",
        }],
      },
    }) };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal(id, [{ unitKey: "goods_1", operation: "REDEEM" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] }, new Date("2026-09-10T00:00:00Z")
    );
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    return { current, quote, submitted, response };
  }

  const mutate = (
    report: AdmissionReport,
    change: (record: Record<string, unknown>) => void
  ) => {
    const clone = structuredClone(report);
    const entry = clone.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    change(entry.satisfactions[0] as unknown as Record<string, unknown>);
    return clone;
  };

  it("rejects a transitionRef belonging to another unit's occurrence", () => {
    const { current, quote, submitted, response } = historicalOrder("ref-other-unit");
    const forged = mutate(response.admissionReport, record => { record.transitionRef = "g2-cancel"; });
    // Core cannot tell: the ref is opaque and well formed.
    expect(() => assertAdmissionReportWellFormed(quote, submitted, forged)).not.toThrow();
    expect(() => assertRetailAdmissionTrace(submitted, quote, forged, current.value)).toThrow();
  });

  it("rejects a transitionRef that resolves to no occurrence", () => {
    const { current, quote, submitted, response } = historicalOrder("ref-missing");
    const forged = mutate(response.admissionReport, record => {
      record.transitionRef = "never-existed";
    });
    expect(() => assertRetailAdmissionTrace(submitted, quote, forged, current.value)).toThrow();
  });

  it("rejects a correct transitionRef paired with a different finalization instant", () => {
    const { current, quote, submitted, response } = historicalOrder("ref-wrong-time");
    const forged = mutate(response.admissionReport, record => {
      record.finalizedAt = "2026-09-02T00:00:00Z";
    });
    expect(() => assertRetailAdmissionTrace(submitted, quote, forged, current.value)).toThrow();
  });
});

describe("canonical historical selection is enforced, not incidental", () => {
  const evaluatedAt = new Date("2026-09-10T00:00:00Z");
  function withHistory(id: string, history: unknown[]) {
    const current = { value: orderState({
      delivery: {
        kind: "DELIVERY", state: "REDEEMED",
        transitionHistory: history as RetailOrderState["units"]["delivery"]["transitionHistory"],
      },
    }) };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal(id, [{ unitKey: "goods_1", operation: "REDEEM" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const response = provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] }, evaluatedAt
    );
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");
    return { current, quote, submitted, response };
  }
  const final = (transitionRef: string, finalizedAt: string) => ({
    status: "FINAL" as const, transitionRef,
    transition: { unitKey: "delivery", operation: "REDEEM" as const }, finalizedAt,
  });
  const citedRef = (response: Extract<ReturnType<ReferenceProvider["commit"]>,
    { kind: "COMMIT_RESULT" }>) => {
    const entry = response.admissionReport.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    const record = entry.satisfactions[0];
    if (record.source !== "PRIOR_FINAL_TRANSITION") throw new Error("Expected prior-final");
    return record.transitionRef;
  };

  it("selects the greatest finalization instant", () => {
    const { response } = withHistory("canon-latest", [
      final("older", "2026-09-01T00:00:00Z"),
      final("newer", "2026-09-05T00:00:00Z"),
    ]);
    expect(citedRef(response)).toBe("newer");
  });

  it("breaks ties on finalizedAt by ordinal transitionRef", () => {
    const { response } = withHistory("canon-tie", [
      final("bbb", "2026-09-05T00:00:00Z"),
      final("aaa", "2026-09-05T00:00:00Z"),
    ]);
    expect(citedRef(response)).toBe("aaa");
  });

  it("skips a malformed newer record in favour of a valid older one", () => {
    const { response } = withHistory("canon-malformed-newer", [
      final("malformed", "2026-09-08"),
      final("valid-older", "2026-09-01T00:00:00Z"),
    ]);
    expect(citedRef(response)).toBe("valid-older");
  });

  it("skips a future-dated newer record in favour of a valid older one", () => {
    const { response } = withHistory("canon-future-newer", [
      final("future", "2026-09-20T00:00:00Z"),
      final("valid-older", "2026-09-01T00:00:00Z"),
    ]);
    expect(citedRef(response)).toBe("valid-older");
  });

  it("rejects a truthful but non-canonical citation", () => {
    // Both occurrences are real and both satisfy the relation, but the
    // binding canonicalizes on the latest. Trace conformance enforces that
    // rule deliberately: the oracle compares against a DEFINED canonical
    // representation, so a reader can reproduce it.
    const { current, quote, submitted, response } = withHistory("canon-enforced", [
      final("older", "2026-09-01T00:00:00Z"),
      final("newer", "2026-09-05T00:00:00Z"),
    ]);
    expect(citedRef(response)).toBe("newer");
    const nonCanonical = structuredClone(response.admissionReport);
    const entry = nonCanonical.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    const record = entry.satisfactions[0];
    if (record.source !== "PRIOR_FINAL_TRANSITION") throw new Error("Expected prior-final");
    record.transitionRef = "older";
    record.finalizedAt = "2026-09-01T00:00:00Z";
    // Core accepts: structurally this is a fine record.
    expect(() => assertAdmissionReportWellFormed(quote, submitted, nonCanonical)).not.toThrow();
    // The binding rejects it as non-canonical, not as untruthful.
    expect(() => assertRetailAdmissionTrace(submitted, quote, nonCanonical, current.value))
      .toThrow(/contradicts the retail binding evaluation trace/);
  });
});

describe("self-attacks against the retail binding contracts", () => {
  it("does not let evidence precedence hide a refused unit", () => {
    // Preferring prior-final evidence changes the ADMISSION explanation
    // only. Execution reporting is independent: the refused unit must
    // still appear in unitResults, and the aggregate hint must show MIXED.
    const current = { value: orderState({
      delivery: {
        kind: "DELIVERY", state: "COMMITTED",
        transitionHistory: [{
          status: "FINAL" as const, transitionRef: "h",
          transition: { unitKey: "delivery", operation: "REDEEM" as const },
          finalizedAt: "2026-09-01T00:00:00Z",
        }],
      },
    }) };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("no-hiding", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    const delivery = quote.units.find(unit => unit.unitLocator.unitKey === "delivery")!;
    const response = provider.commit({
      quoteId: quote.quoteId,
      acceptanceConstraints: [{
        effectId: delivery.effects[0].effectId,
        operator: "<=",
        value: { type: "money", amount: "-1.00", currency: "USD" },
      }],
    }, new Date("2026-09-10T00:00:00Z"));
    if (response.kind !== "COMMIT_RESULT") throw new Error("Expected COMMIT_RESULT");

    const entry = response.admissionReport.coverage[0];
    if (entry.status !== "PASSED" || !entry.satisfactions) throw new Error("Expected evidence");
    expect(entry.satisfactions[0].source).toBe("PRIOR_FINAL_TRANSITION");
    // Execution still reports the refusal plainly.
    expect(response.commitResult.unitResults.find(item => item.unitRef === delivery.unitRef)
      ?.outcome).toBe("REFUSED");
    expect(response.commitResult.aggregateHint).toBe("MIXED");
    expect(() => assertCommitResponseWellFormed(quote, submitted, response)).not.toThrow();
  });

  it("enforces transitionRef uniqueness on units the evaluation does not cite", () => {
    // The check is a property of the history it reads, not only of the
    // record it happens to select.
    const current = { value: orderState({
      goods_1: {
        kind: "GOODS", state: "ACTIVE",
        transitionHistory: [
          { status: "FINAL" as const, transitionRef: "dup",
            transition: { unitKey: "goods_1", operation: "CANCEL" as const },
            finalizedAt: "2026-09-01T00:00:00Z" },
          { status: "FINAL" as const, transitionRef: "dup",
            transition: { unitKey: "goods_1", operation: "REDEEM" as const },
            finalizedAt: "2026-09-02T00:00:00Z" },
        ],
      },
    }) };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("unused-unit-dup", [
      { unitKey: "goods_1", operation: "REDEEM" },
      { unitKey: "delivery", operation: "REDEEM" },
    ]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    expect(() => provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] }, new Date("2026-09-10T00:00:00Z")
    )).toThrow(/reuses transitionRef "dup"/);
  });

  it("enforces transitionRef uniqueness across non-final records too", () => {
    // A SUBMITTED and a FINAL record sharing a ref is still an ambiguous
    // occurrence identity, even though only the FINAL one could be cited.
    const current = { value: orderState({
      delivery: {
        kind: "DELIVERY", state: "REDEEMED",
        transitionHistory: [
          { status: "SUBMITTED" as const, transitionRef: "x",
            transition: { unitKey: "delivery", operation: "REDEEM" as const } },
          { status: "FINAL" as const, transitionRef: "x",
            transition: { unitKey: "delivery", operation: "REDEEM" as const },
            finalizedAt: "2026-09-01T00:00:00Z" },
        ],
      },
    }) };
    const { provider, syncSnapshot } = configuredProvider(current);
    const submitted = proposal("mixed-status-dup", [{ unitKey: "goods_1", operation: "REDEEM" }]);
    const quote = provider.quote(submitted);
    syncSnapshot();
    expect(() => provider.commit(
      { quoteId: quote.quoteId, acceptanceConstraints: [] }, new Date("2026-09-10T00:00:00Z")
    )).toThrow(/reuses transitionRef "x"/);
  });

  it("selects the same record regardless of history array order on a tie", () => {
    const build = (refs: string[]) => ({
      orderId: "order_799", version: 1,
      units: {
        delivery: {
          kind: "DELIVERY" as const, state: "REDEEMED" as const,
          transitionHistory: refs.map(transitionRef => ({
            status: "FINAL" as const, transitionRef,
            transition: { unitKey: "delivery", operation: "REDEEM" as const },
            finalizedAt: "2026-09-05T00:00:00Z",
          })),
        },
      },
    });
    const at = Date.parse("2026-09-10T00:00:00Z");
    expect(selectRetailPriorFinal(build(["bbb", "aaa"]), "delivery", "REDEEM", at)?.transitionRef)
      .toBe("aaa");
    expect(selectRetailPriorFinal(build(["aaa", "bbb"]), "delivery", "REDEEM", at)?.transitionRef)
      .toBe("aaa");
  });
});
