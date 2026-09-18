import { expect, it } from "vitest";
import { ReferenceProvider } from "../../src/core/reference-provider";
import { assertAdmissionRefusalWellFormed } from "../../src/core/validate";
import { initial, quoter, evaluate, amend } from "../bindings/merchant-batch";

it("v0.3.0: three COMPLETE witnesses still require three refusal/repair cycles", () => {
  let dispatches = 0;
  const provider = new ReferenceProvider(quoter, { onCommit: (_q, u) => { dispatches++; return u.effects; } }, {}, p => evaluate(p, true));
  let proposal = initial();
  const quoteIds = new Set<string>();
  let cycles = 0;
  for (const order of ["A", "B", "C"]) {
    const quote = provider.quote(proposal);
    quoteIds.add(quote.quoteId);
    const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
    expect(response.kind).toBe("ADMISSION_REFUSED");
    if (response.kind !== "ADMISSION_REFUSED") throw Error("Expected refusal");
    expect(() => assertAdmissionRefusalWellFormed(quote, proposal, response.admissionRefusal)).not.toThrow();
    const failures = response.admissionRefusal.failures;
    expect(failures).toHaveLength(1);
    expect(failures[0].relationId).toBe(`requires:${order}`);
    expect(failures[0].witness.disposition).toBe("COMPLETE");
    expect(dispatches).toBe(0);
    if (failures[0].witness.disposition !== "COMPLETE") throw Error("Expected complete");
    proposal = amend(proposal, failures[0].witness.requiredTransitions, `repair-${++cycles}`);
  }
  const quote = provider.quote(proposal);
  quoteIds.add(quote.quoteId);
  expect(provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] }).kind).toBe("COMMIT_RESULT");
  expect(cycles).toBe(3);
  expect(quoteIds.size).toBe(4);
  expect(dispatches).toBe(6);
  console.log("Observed v0.3.0: 3 refusal/repair cycles; 4 quotes; 0 dispatches on each refusal.");
});

it("v0.3.0 cannot distinguish omitted failure from passed or deferred relation", () => {
  const proposal = initial();
  const provider = new ReferenceProvider(quoter, {}, {}, p => evaluate(p));
  const quote = provider.quote(proposal);
  const response = provider.commit({ quoteId: quote.quoteId, acceptanceConstraints: [] });
  if (response.kind !== "ADMISSION_REFUSED") throw Error("Expected refusal");
  expect(response.admissionRefusal.failures).toHaveLength(3);
  response.admissionRefusal.failures.pop();
  expect(() => assertAdmissionRefusalWellFormed(quote, proposal, response.admissionRefusal)).not.toThrow();
});
