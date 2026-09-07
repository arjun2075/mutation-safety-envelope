import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../schema/mse-core.schema.json";
import { ReferenceProvider, type AdmissionEvaluator } from "../src/core/reference-provider";
import { assertAdmissionCoverageWellFormed, assertAdmissionRefusalWellFormed, assertCommitResultCoversAllUnits } from "../src/core/validate";
import type { AdmissionCoverage, AdmissionRefusal, MutationProposal } from "../src/core/types";
import { amend, authorized, evaluate, initial, items, orders, quoter, scope } from "./bindings/merchant-batch";

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const exhaustive: AdmissionEvaluator = proposal => {
  const { failures, visited } = evaluate(proposal);
  return { failures, coverage: visited.map(relationId => ({ relationId,
    status: failures.some(f => f.relationId === relationId) ? "FAILED" : "PASSED" })) };
};
function setup(admission = exhaustive, fault: ConstructorParameters<typeof ReferenceProvider>[2] = {}) {
  let dispatches = 0;
  const provider = new ReferenceProvider(quoter, { onCommit: (_q, u) => { dispatches++; return u.effects; } }, fault, admission);
  return { provider, dispatches: () => dispatches };
}
function refusalCase() {
  const { provider, dispatches } = setup();
  const proposal = initial();
  const quote = provider.quote(proposal);
  const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
  if (response.kind !== "ADMISSION_REFUSED") throw Error("Expected refusal");
  return { provider, proposal, quote, refusal: response.admissionRefusal, dispatches };
}
function repairs(refusal: AdmissionRefusal) {
  return refusal.failures.flatMap(f => {
    if (f.witness.disposition !== "COMPLETE") throw Error("Not a complete repair");
    return f.witness.requiredTransitions;
  });
}
/** Binding conformance oracle: evaluate real inputs, compare by relation identity. */
function assertMerchantTrace(proposal: MutationProposal, refusal: AdmissionRefusal) {
  const expected = exhaustive(proposal, {} as never, new Date());
  expect([...refusal.coverage].sort((a,b) => a.relationId.localeCompare(b.relationId)))
    .toEqual([...expected.coverage].sort((a,b) => a.relationId.localeCompare(b.relationId)));
  expect([...refusal.failures].sort((a,b) => a.relationId.localeCompare(b.relationId)))
    .toEqual([...expected.failures].sort((a,b) => a.relationId.localeCompare(b.relationId)));
}

describe("independent request-level reporting", () => {
  it("returns all three independent failures and constructs one reauthorized, freshly evaluated repair", () => {
    const { provider, proposal, quote, refusal, dispatches } = refusalCase();
    expect(refusal.failures.map(f => f.relationId)).toEqual(orders.map(o => `requires:${o}`));
    expect(new Set(quote.admissionRelations.map(r => r.relationId)).size).toBe(3);
    expect(new Set(refusal.coverage.map(entry => entry.relationId)))
      .toEqual(new Set(quote.admissionRelations.map(relation => relation.relationId)));
    expect(() => assertAdmissionRefusalWellFormed(quote, proposal, refusal)).not.toThrow();
    expect(validate({ quote, commitResponse: { kind: "ADMISSION_REFUSED", admissionRefusal: refusal } })).toBe(true);
    assertMerchantTrace(proposal, refusal);
    const required = repairs(refusal);
    expect(required).toHaveLength(3);
    for (const [i, r] of required.entries()) {
      expect(r.unitLocator).toEqual({ scopeRef: scope(orders[i]), unitKey: "delivery" });
      expect(r.transition).toEqual({ order: orders[i], unitKey: "delivery", operation: "REDEEM" });
      expect(quote.units.some(u => JSON.stringify(u.unitLocator) === JSON.stringify(r.unitLocator))).toBe(false);
    }
    expect(dispatches()).toBe(0);
    const amended = amend(proposal, required, "batch-repair");
    const onlyGoods = new Set(orders.map(o => `${o}:goods`));
    expect(authorized(proposal, onlyGoods)).toBe(true);
    expect(authorized(amended, onlyGoods)).toBe(false);
    // Binding authorization before quote/commit; witness has not extended permissions.
    const permitted = new Set([...onlyGoods, ...orders.map(o => `${o}:delivery`)]);
    if (!authorized(amended, permitted)) throw Error("Unauthorized amendment");
    const newQuote = provider.quote(amended);
    expect(newQuote.quoteId).not.toBe(quote.quoteId);
    expect(items(proposal)).toHaveLength(3);
    expect(newQuote.units).toHaveLength(6);
    const result = provider.commit({ quoteId: newQuote.quoteId, acceptanceConstraints: [] });
    expect(result.kind).toBe("COMMIT_RESULT");
    if (result.kind !== "COMMIT_RESULT") throw Error("Expected result");
    assertCommitResultCoversAllUnits(newQuote, result.commitResult);
    expect(result.commitResult.aggregateHint).toBe("ALL_APPLIED");
    expect(dispatches()).toBe(6);
  });

  it.each(["duplicate", "contradictory", "wrong order"])("binding rejects %s in a union repair", kind => {
    const { proposal, refusal } = refusalCase();
    const required = repairs(refusal);
    if (kind === "duplicate") required.push(required[0]);
    if (kind === "contradictory") required.push({ ...required[0], transition: { order: "A", unitKey: "delivery", operation: "CANCEL" } });
    if (kind === "wrong order") required[0] = { ...required[0], unitLocator: { scopeRef: scope("B"), unitKey: "delivery" } };
    expect(() => amend(proposal, required, "invalid-amendment")).toThrow();
  });

  it("rejects omission of independently failing C even when A and B are COMPLETE", () => {
    const { proposal, quote, refusal } = refusalCase();
    refusal.failures.pop();
    expect(() => assertAdmissionRefusalWellFormed(quote, proposal, refusal)).toThrow(/contradicts/);
    refusal.coverage.pop();
    expect(() => assertAdmissionRefusalWellFormed(quote, proposal, refusal)).toThrow(/omits/);
  });

  it("treats coverage, failures, and dependency ordering as non-semantic", () => {
    const { proposal, quote, refusal } = refusalCase();
    refusal.failures = [refusal.failures[1], refusal.failures[0]];
    refusal.coverage = [
      {
        relationId: "requires:C",
        status: "DEFERRED",
        dependsOn: ["requires:B", "requires:A"],
      },
      { relationId: "requires:A", status: "FAILED" },
      { relationId: "requires:B", status: "FAILED" },
    ];

    expect(() => assertAdmissionRefusalWellFormed(quote, proposal, refusal)).not.toThrow();

    const reversed = structuredClone(refusal);
    reversed.failures.reverse();
    reversed.coverage.reverse();
    const deferred = reversed.coverage.find(entry => entry.status === "DEFERRED");
    if (deferred?.status !== "DEFERRED") throw Error("Expected deferred coverage");
    deferred.dependsOn.reverse();

    expect(() => assertAdmissionRefusalWellFormed(quote, proposal, reversed)).not.toThrow();
  });

  it("accepts an acyclic deferred chain that terminates in a failed relation", () => {
    const { proposal, quote, refusal } = refusalCase();
    refusal.failures = [refusal.failures[0]];
    refusal.coverage = [
      { relationId: "requires:C", status: "DEFERRED", dependsOn: ["requires:B"] },
      { relationId: "requires:A", status: "FAILED" },
      { relationId: "requires:B", status: "DEFERRED", dependsOn: ["requires:A"] },
    ];

    expect(validate({ commitResponse: { kind: "ADMISSION_REFUSED", admissionRefusal: refusal } })).toBe(true);
    expect(() => assertAdmissionRefusalWellFormed(quote, proposal, refusal)).not.toThrow();
  });

  it("a lying PASSED or DEFERRED C requires a binding trace to disprove", () => {
    const { proposal, quote, refusal } = refusalCase();
    refusal.failures.pop();
    for (const entry of [
      { relationId: "requires:C", status: "PASSED" },
      { relationId: "requires:C", status: "DEFERRED", dependsOn: ["requires:A"] },
    ] as AdmissionCoverage[]) {
      refusal.coverage[2] = entry;
      // Structural checks cannot prove opaque state/applicability claims.
      expect(() => assertAdmissionRefusalWellFormed(quote, proposal, refusal)).not.toThrow();
      expect(() => assertMerchantTrace(proposal, refusal)).toThrow();
    }
  });

  it("rejects the deliberately fail-fast provider before dispatch", () => {
    const { provider, dispatches } = setup(p => {
      const { failures, visited } = evaluate(p, true);
      return { failures, coverage: visited.map(relationId => ({ relationId, status: "FAILED" })) };
    });
    const quote = provider.quote(initial());
    expect(() => provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })).toThrow(/omits/);
    expect(dispatches()).toBe(0);
  });

  it("does not infer atomicity or finality from an aggregated repair; reconciliation reads the prior attempt", () => {
    let evaluations = 0;
    let timeoutChecks = 0;
    let reads = 0;
    const { provider, dispatches } = setup((...args) => { evaluations++; return exhaustive(...args); }, {
      shouldTimeout: (_r, _q, u) => { timeoutChecks++; return u.unitLocator.scopeRef === scope("C") && u.unitLocator.unitKey === "delivery"; },
      reconciliationOutcome: () => { reads++; return "REFUSED"; },
    });
    const proposal = initial();
    const quote = provider.quote(proposal);
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    if (response.kind !== "ADMISSION_REFUSED") throw Error("Expected refusal");
    expect(dispatches()).toBe(0);
    expect(timeoutChecks).toBe(0);
    const amended = amend(proposal, repairs(response.admissionRefusal), "mixed");
    const next = provider.quote(amended);
    const b = next.units.find(u => u.unitLocator.scopeRef === scope("B") && u.unitLocator.unitKey === "delivery")!;
    const result = provider.commit({ quoteId: next.quoteId, acceptanceConstraints: [{ effectId: b.effects[0].effectId, operator: "==", value: { type: "number", value: 1 } }] });
    if (result.kind !== "COMMIT_RESULT") throw Error("Expected result");
    expect(evaluations).toBe(2);
    assertCommitResultCoversAllUnits(next, result.commitResult);
    expect(new Set(result.commitResult.unitResults.map(u => u.outcome))).toEqual(new Set(["APPLIED", "REFUSED", "INDETERMINATE"]));
    const unknown = result.commitResult.unitResults.find(u => u.outcome === "INDETERMINATE")!;
    const before = timeoutChecks;
    expect(provider.reconcile(unknown.reconciliation!.correlationId!)).toBe("REFUSED");
    expect(reads).toBe(1);
    expect(timeoutChecks).toBe(before);
    expect(evaluations).toBe(2);
    expect(provider.receipt(next.quoteId).effectReceipts).toHaveLength(4);
  });
});

// A neutral test binding: relation B's required companion is resolved only from
// a selector added by A's repair to a NEW proposal. No hypothetical state is read.
function dependentBinding() {
  let bReads = 0;
  const proposal: MutationProposal = { proposalId: "dependent", target: "fixture", change: ["trigger"] };
  const makeQuote = (p: MutationProposal) => ({ target: p.target,
    units: (p.change as string[]).map(key => ({ unitRef: key, unitLocator: { scopeRef: "fixture", unitKey: key }, transition: key, effects: [] })),
    admissionRelations: ["A", "B"].map(relationId => ({ relationId, type: "REQUIRES_COINCLUSION" as const, scopeRef: "fixture", triggerUnitRefs: ["trigger"] })),
  });
  const evaluate: AdmissionEvaluator = p => {
    const change = p.change as string[];
    if (!change.includes("selector")) return {
      failures: [{ relationId: "A", witness: { disposition: "COMPLETE", requiredTransitions: [{ unitLocator: { scopeRef: "fixture", unitKey: "selector" }, transition: "selector" }] } }],
      coverage: [{ relationId: "A", status: "FAILED" }, { relationId: "B", status: "DEFERRED", dependsOn: ["A"] }],
    };
    bReads++;
    return {
      failures: change.includes("companion") ? [] : [{ relationId: "B", witness: { disposition: "COMPLETE", requiredTransitions: [{ unitLocator: { scopeRef: "fixture", unitKey: "companion" }, transition: "companion" }] } }],
      coverage: [{ relationId: "A", status: "PASSED" }, { relationId: "B", status: change.includes("companion") ? "PASSED" : "FAILED" }],
    };
  };
  return { proposal, makeQuote, evaluate, bReads: () => bReads };
}

describe("dependent evaluation", () => {
  it("distinguishes failed, deferred, then passed and newly failed on a new proposal", () => {
    const binding = dependentBinding();
    let dispatches = 0;
    const provider = new ReferenceProvider(binding.makeQuote, { onCommit: (_q,u) => { dispatches++; return u.effects; } }, {}, binding.evaluate);
    let proposal = binding.proposal;
    const ids = new Set<string>();
    for (const failed of ["A", "B"]) {
      const quote = provider.quote(proposal);
      ids.add(quote.quoteId);
      const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
      if (response.kind !== "ADMISSION_REFUSED") throw Error("Expected refusal");
      expect(validate({ commitResponse: response })).toBe(true);
      expect(response.admissionRefusal.failures.map(f => f.relationId)).toEqual([failed]);
      expect(response.admissionRefusal.coverage).toEqual(failed === "A"
        ? [{ relationId: "A", status: "FAILED" }, { relationId: "B", status: "DEFERRED", dependsOn: ["A"] }]
        : [{ relationId: "A", status: "PASSED" }, { relationId: "B", status: "FAILED" }]);
      expect(binding.bReads()).toBe(failed === "A" ? 0 : 1);
      expect(dispatches).toBe(0);
      proposal = { ...proposal, proposalId: `after-${failed}`, change: [...proposal.change as string[], ...repairs(response.admissionRefusal).map(r => r.transition)] };
    }
    const quote = provider.quote(proposal);
    ids.add(quote.quoteId);
    expect(provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] }).kind).toBe("COMMIT_RESULT");
    expect(ids.size).toBe(3);
    expect(binding.bReads()).toBe(2);
    expect(dispatches).toBe(3);
  });

  it("cannot fabricate an evaluated B from hypothetical repaired inputs", () => {
    const binding = dependentBinding();
    const provider = new ReferenceProvider(binding.makeQuote, {}, {}, binding.evaluate);
    const quote = provider.quote(binding.proposal);
    const actual = binding.evaluate(binding.proposal, quote, new Date());
    const fabricated = structuredClone(actual);
    fabricated.coverage[1] = { relationId: "B", status: "PASSED" };
    expect(() => assertAdmissionCoverageWellFormed(quote, fabricated.failures, fabricated.coverage)).not.toThrow();
    expect(fabricated.coverage).not.toEqual(actual.coverage);
    expect(binding.bReads()).toBe(0);
  });
});

const mutations: [string, (r: AdmissionRefusal) => void, boolean][] = [
  ["missing coverage", r => { delete (r as Partial<AdmissionRefusal>).coverage; }, false],
  ["empty coverage", r => { r.coverage = []; }, false],
  ["duplicate identical relation", r => { r.coverage.push(r.coverage[0]); }, false],
  ["duplicate relation with different status", r => { r.coverage.push({ relationId: "requires:A", status: "PASSED" }); }, true],
  ["undeclared relation", r => { r.coverage[2].relationId = "unknown"; }, true],
  ["FAILED without failure", r => { r.failures.pop(); }, true],
  ["duplicate failure relation", r => { r.failures.push(structuredClone(r.failures[0])); }, true],
  ["undeclared failure relation", r => { r.failures[2].relationId = "unknown"; }, true],
  ["PASSED with failure", r => { r.coverage[2].status = "PASSED"; }, true],
  ["DEFERRED with failure", r => { r.coverage[2] = { relationId: "requires:C", status: "DEFERRED", dependsOn: ["requires:A"] }; }, true],
  ["early-stop status", r => { (r.coverage[2] as {status: string}).status = "NOT_EVALUATED"; }, false],
  ["dependency in passed branch", r => { r.coverage[2] = { relationId: "requires:C", status: "PASSED", dependsOn: ["requires:A"] } as unknown as AdmissionCoverage; }, false],
  ["missing dependency", r => { r.failures.pop(); r.coverage[2] = { relationId: "requires:C", status: "DEFERRED" } as AdmissionCoverage; }, false],
  ["empty dependencies", r => { r.failures.pop(); r.coverage[2] = { relationId: "requires:C", status: "DEFERRED", dependsOn: [] }; }, false],
  ["duplicate dependencies", r => { r.failures.pop(); r.coverage[2] = { relationId: "requires:C", status: "DEFERRED", dependsOn: ["requires:A", "requires:A"] }; }, false],
  ["undeclared dependency", r => { r.failures.pop(); r.coverage[2] = { relationId: "requires:C", status: "DEFERRED", dependsOn: ["unknown"] }; }, true],
  ["self dependency", r => { r.failures.pop(); r.coverage[2] = { relationId: "requires:C", status: "DEFERRED", dependsOn: ["requires:C"] }; }, true],
  ["dependency on PASSED", r => { r.failures.splice(1); r.coverage[1].status = "PASSED"; r.coverage[2] = { relationId: "requires:C", status: "DEFERRED", dependsOn: ["requires:B"] }; }, true],
  ["dependency cycle", r => { r.failures.splice(1); r.coverage[1] = { relationId: "requires:B", status: "DEFERRED", dependsOn: ["requires:C"] }; r.coverage[2] = { relationId: "requires:C", status: "DEFERRED", dependsOn: ["requires:B", "requires:A"] }; }, true],
];
describe("schema and semantic coverage negatives", () => {
  it.each(mutations)("rejects %s with the appropriate validation layer", (_name, mutate, schemaAccepts) => {
    const { proposal, quote, refusal } = refusalCase();
    mutate(refusal);
    expect(validate({ commitResponse: { kind: "ADMISSION_REFUSED", admissionRefusal: refusal } })).toBe(schemaAccepts);
    expect(() => assertAdmissionRefusalWellFormed(quote, proposal, refusal)).toThrow();
  });
  it("rejects coverage attached to the COMMIT_RESULT or witness branch", () => {
    const { refusal } = refusalCase();
    expect(validate({ commitResponse: { kind: "COMMIT_RESULT", coverage: refusal.coverage,
      commitResult: { quoteId: "q", unitResults: [{ unitRef: "u", outcome: "REFUSED", refusalReason: "PROVIDER_REJECTED" }] } } })).toBe(false);
    Object.assign(refusal.failures[0].witness, { coverage: refusal.coverage });
    expect(validate({ commitResponse: { kind: "ADMISSION_REFUSED", admissionRefusal: refusal } })).toBe(false);
  });
  it("validates coverage even when the hook claims no failures", () => {
    const { provider, dispatches } = setup(() => ({ failures: [], coverage: [] }));
    const quote = provider.quote(initial());
    expect(() => provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] })).toThrow(/omits/);
    expect(dispatches()).toBe(0);
  });
});
