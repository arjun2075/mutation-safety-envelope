# Tests

- `core.test.ts` — behavioral tests for `/src/core`: fail-closed acceptance
  constraint evaluation (correlated by `effectId` across units), quote
  expiry, EXACT-guarantee drift detection, quote/unit well-formedness
  (`assertQuoteUnitsWellFormed`), commit-result coverage
  (`assertCommitResultCoversAllUnits`), the `INDETERMINATE` reconciliation
  contract (`assertReconciliationContractHonored`), and full-lifecycle
  scenarios run against `ReferenceProvider` — including mixed-outcome
  commit attempts (`APPLIED`+`REFUSED`, `APPLIED`+`INDETERMINATE` in the
  same `CommitResult`) and reconciliation resolving to `APPLIED`, to
  `REFUSED`, and remaining unresolved.
- `admission.test.ts` — v0.3.0 cross-unit admission behavior using the
  executable retail binding: both delivery gates, live complete witnesses,
  exclusion of already-satisfied requirements, zero-dispatch refusals,
  partial/unavailable/malformed evidence, duplicate/wrong-scope/unresolvable
  references, binding-owned authorization, fresh re-quote/revalidation,
  preserved expiry/snapshot/acceptance constraints, and later mixed or
  `INDETERMINATE` per-unit results.
- `schema-conformance.test.ts` — validates every `*.fixture.json` file
  under `/examples` against `/schema/mse-core.schema.json` using ajv in
  strict mode, plus a set of negative cases asserting the schema *rejects*
  v0.1.0 shapes, malformed v0.2.0 reconciliation contracts, and malformed
  v0.3.0 admission messages.

## Admission behavior is tested before dispatch

`test/admission.test.ts` uses `DriftSimulator.onCommit` as an observable
dispatch counter. Every `ADMISSION_REFUSED` and malformed-witness case asserts
that the counter remains zero. A valid co-included proposal proceeds into the
unchanged per-unit loop. Separate tests then force a dependent delivery unit
to be refused by an acceptance constraint or become `INDETERMINATE`; this is
intentional evidence that admission co-inclusion is not atomic commit.

The retail binding reads mutable order state at each admission. Its repair
test applies a complete witness to a new proposal, changes state, obtains a
new quote, and observes a new witness. This demonstrates that stale evidence
cannot bypass fresh evaluation. The reference provider's synchronous
in-process check is still not a distributed lock; that limitation is recorded
in the normative spec and security considerations.

## `ReferenceProvider` does exercise `INDETERMINATE` end-to-end, per unit

As of v0.2.0, `ReferenceProvider` accepts a `FaultInjector` with two
hooks: `shouldTimeout(request, quote, unit)` — scoped per unit, so one
unit in a multi-unit commit attempt can time out while another applies
cleanly — and `reconciliationOutcome(quote, unit)`, which simulates what a
later reconciliation/authoritative-read attempt discovers for that unit:
`"APPLIED"`, `"REFUSED"`, or `undefined` (still unresolvable). This is
deliberately not hardcoded to always resolve to `"APPLIED"` — see
`test/core.test.ts`'s (G)/(H)/(I) reconciliation tests, which each
exercise a different one of the three outcomes through real code, not
only as static fixtures. `provider.reconcile(correlationId)` performs the
resolution as a lookup against the fault injector's stated outcome, not by
calling `commit()` again — see `/spec/normative-spec.md` §4c for why that
distinction is normatively required, not just a reference-implementation
style choice.

*(This section previously claimed no such test existed at all. That
claim was already stale before this revision — fault injection for a
single mutation-wide `INDETERMINATE` was added in the v0.1.0 hardening
pass — and is corrected here rather than left to compound further.)*

## Known gap: the blind-retry failure mode itself is undemonstrated

The reconciliation tests prove the *correct* path — reconciling by
`correlationId` — resolves a unit without replaying its mutation. Nothing
in this test suite demonstrates what actually goes wrong if a caller
ignores the spec and calls `commit()` again for an indeterminate unit
instead of reconciling (e.g. producing a duplicate `APPLIED` result for
that unit). Proving the remedy works is not the same as proving the
hazard it addresses is reproducible in this reference implementation. A
future revision could add a test that deliberately performs a naive
second `commit()` call after an `INDETERMINATE` result and shows the
resulting (unsafe) duplication, to make the hazard concrete rather than
only asserted in prose. Tracked here rather than silently omitted — see
also `/docs/falsification-notes.md` and `/docs/readiness-report.md`.

## Running

```bash
npm install
npm test
```

The v0.3.0 candidate currently runs 142 tests. The untouched v0.2.0 base ran
102; the older 84-test count in historical documentation was stale.
