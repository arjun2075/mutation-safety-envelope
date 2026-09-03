# Publication readiness report

**Current status: v0.2.0, published.** This repository was published
publicly at `github.com/arjun2075/mutation-safety-envelope` following the
v0.1.0 hardening pass recorded below. That publication included creating
the public repository, pushing `main`, tagging and releasing `v0.1.0`, and
opening it for external review (which subsequently produced UCP
Discussion #799 — see
[`/docs/v0.2-review-response.md`](./v0.2-review-response.md)). The
"not been pushed publicly" language in the v0.1.0 section below reflects
this document's state *at the time that pass was written*, before
publication; it is preserved as the historical record of that pre-publication
gate rather than rewritten, and should not be read as describing the
repository's current state. **v0.2.0 (this revision) has not been tagged
or released** — see "v0.2.0 status" immediately below.

## v0.2.0 status (review-hardening revision, current)

v0.2.0 was developed on branch `v0.2-review-hardening` in direct response
to external technical falsification (UCP Discussion #799), per an explicit
task scoped to: model per-unit commit outcomes, add a normative
`INDETERMINATE` reconciliation contract, resolve the ambiguities that
raised, add tests, update all normative/reference artifacts consistently,
and fix stale documentation found along the way. See
[`/docs/v0.2-review-response.md`](./v0.2-review-response.md) for the full
account of what was falsified and what changed, and
`/spec/normative-spec.md` §9 for the exact compatibility/breaking-change
table.

- Tests: 84/84 passing (up from 47 at the end of the v0.1.0 hardening
  pass) — see "Test results" below for the breakdown.
- TypeScript: clean (`npx tsc -p tsconfig.json --noEmit`, and `npm run
  build`).
- Schema: compiles under ajv strict mode, draft 2020-12 (`npm run
  validate-schema`), first try, no new strict-mode issues found while
  authoring the v0.2.0 changes.
- This is a **breaking** schema revision (v0.1.0 messages are not valid
  v0.2.0 messages, and vice versa — see spec §9), not an additive one. No
  domain vocabulary was added; MSE's transport-neutral, identity-agnostic,
  domain-blind boundaries (spec §1) are unchanged.
- **Per this task's explicit instruction, v0.2.0 has not been tagged as a
  production/stable release.** It exists on the `v0.2-review-hardening`
  branch, committed, pending a human decision on merging and/or tagging.

### v0.2.0 remaining risks

**BLOCKER:** none identified for merging this branch as a further
external-review candidate.

**NON-BLOCKER:**

1. **Cross-unit/shared effects remain unrepresentable** (spec §7a, §8).
   Flagged, not resolved — a real provider example is needed before
   guessing at a shape.
2. **No test demonstrates the blind-retry failure mode itself**, only
   that the correct reconciliation path avoids it. See
   `/docs/falsification-notes.md` item 7 and `/test/README.md`.
3. **A reconciliation path's "observes, does not replay" property is a
   documentation obligation on bindings (spec §4b), not something the
   core schema can verify mechanically.** A binding could claim
   compliance and be wrong; this is a limitation of what a schema alone
   can enforce, named explicitly in
   `/docs/security-considerations.md` §3a rather than glossed over.
4. **Only one domain example (retail) has a genuinely multi-unit
   fixture.** Travel, subscription, and contract-billing remain
   single-unit in this revision. See `/docs/conformance.md`'s "Known
   conformance gaps" section.
5. **This is still self-consistency validation for the new shapes
   specifically** — schema, reference implementation, and tests for
   `CommittingUnit`/`UnitResult`/`Reconciliation`/`effectId` were all
   authored together in this same pass, informed by one round of external
   critique but not yet independently reviewed themselves. See
   `/docs/falsification-notes.md`.

### v0.2.0 recommendation

Ready for further external review on the `v0.2-review-hardening` branch.
Whether and when to merge to `main` and/or tag a `v0.2.0` release is a
human decision this document does not make — consistent with the task's
explicit instruction not to tag a production/stable release as part of
this work.

---

## v0.1.0 hardening pass (historical record, preserved as originally written)

Prepared per requirement 11 of the source handoff brief
(`MSE_AGENT_HANDOFF.md` → "Instructions for another coding/research agent"),
updated following a focused hardening pass requested before publication.
**This repository has not been pushed publicly [at the time this section
was written].** This report is the pre-publication gate; publication
requires a separate, explicit go-ahead. *(See the "Current status" note
at the top of this document — the repository has since been published;
this section is preserved unedited below as the historical record of the
v0.1.0 pass.)*

## What changed in this hardening pass

Scope was deliberately constrained: fix the monetary-constraint gap, add
real `INDETERMINATE` coverage, resolve three ambiguities minimally, add
tests, re-run all verification. No new domain concepts, no protocol
redesign.

1. **`AcceptanceConstraint` monetary bounds are now enforceable.** Added
   `ComparableValue` (discriminated union: `number`, `money`, `timestamp`,
   `boolean`, `string`) to the core schema and TypeScript types. Money
   comparison fails closed on variant mismatch and on currency mismatch,
   and uses decimal-safe BigInt-based string comparison — never a native
   float parse. See `/spec/normative-spec.md` §4a,
   `/src/core/validate.ts` (`compareComparableValues`,
   `compareDecimalStrings`, `isComparableValue`). All four domain examples
   now carry a working `acceptance-constraint.fixture.json` demonstrating
   an enforceable monetary bound, including the brief's own
   `fare_delta <= USD 150` example.
2. **End-to-end `INDETERMINATE` coverage.** `ReferenceProvider` gained a
   `FaultInjector` hook (`shouldTimeout`) that forces a commit into
   `INDETERMINATE` the way a real downstream timeout would, plus
   `reconcileIndeterminateCommit()`, which resolves a prior indeterminate
   attempt by idempotency key rather than by blindly resubmitting the
   mutation. `test/core.test.ts`'s "INDETERMINATE end-to-end" test
   exercises the full path and asserts `committedEffects` is absent on the
   indeterminate result (the provider must not claim to know effects it
   does not know occurred).
3. **Three ambiguities resolved minimally:**
   - `RefusalReason` is now a `oneOf`: the same five standard reasons, or a
     namespaced extension string (`<namespace>:<local_reason>`), not an
     unboundedly open string and not a redesign of the reason vocabulary.
   - "Non-mutating quote" now explicitly permits a disclosed, reversible
     hold (as an `Effect`) as the only exception, and explicitly forbids
     undisclosed or non-reversible ones.
   - `MutationQuote.snapshot` is now explicitly documented as
     opaque/provider-defined, with adapter-level documentation of drift
     detection required rather than a universal snapshot-token scheme
     mandated (which the core cannot enforce compliance with anyway).
   - Receipt coverage is now fail-clear: every committed effect MUST
     appear in `effectReceipts` (with `UNKNOWN` finality if untrackable),
     enforced both normatively (spec §7) and defensively in the reference
     provider itself (`receipt()` back-fills any omission).
   See `/docs/ambiguities.md` for full before/after detail on each.
4. **A real bug in the repository's own tooling was found and fixed
   during this pass, unrelated to the schema:** `package.json`'s
   `validate-schema` script invoked the `ajv` CLI (`ajv-cli` package),
   which was never a dependency — the script was silently non-functional
   since the original pass, and nothing had actually run it before now.
   Replaced with `scripts/validate-schema.mjs`, which uses the `ajv`
   library directly (the same strict-mode 2020-12 compile path
   `test/schema-conformance.test.ts` already exercised) and now verifiably
   runs. Recorded here because a scan for "unsupported claims" ought to
   include a repo's own claimed tooling actually working.

## 1. Unresolved semantics (remaining)

Only one ambiguity remains open, ranked by how load-bearing it is:

1. **Concurrent quotes against the same target** (ambiguities §5). Narrowed
   by §6's provider-defined-snapshot resolution (providers must now at
   least document their concurrency answer) but not itself resolved —
   deliberately left for external review rather than guessed at, per this
   pass's explicit scope constraint against redesigning the protocol.

The four other ambiguities tracked in the original readiness report
(`RefusalReason` extensibility, partial receipts, monetary constraints,
non-mutating-quote boundary) are resolved — see "What changed" above and
`/docs/ambiguities.md`.

## 2. Unsupported claims

Unchanged from the original pass plus one addition:

- No vendor-endorsement claims (verified below).
- No claim of official UCP conformance testing (verified below).
- No claim of real (non-reference) provider validation — still true; see
  `/docs/falsification-notes.md`.
- No claim that the four domain examples are complete or
  production-representative.
- **New:** no claim that `npm run validate-schema` worked prior to this
  pass, since it did not — see item 4 under "What changed" above. This is
  disclosed rather than quietly fixed without mention, consistent with
  this report's own standard for prior claims.

Verification commands re-run for this pass (both excluding `node_modules`,
which was correctly excluded by intent in the original pass but the
originally-documented command lacked the flag — also fixed in this pass):

```bash
grep -rniE "official (ucp|acp|shopify|salesforce|iata|paid|stripe|paddle|zuora|chargebee)|endorsed by|certified by" \
  --include='*.md' --include='*.json' --include='*.ts' --exclude-dir=node_modules .
```

```bash
grep -rniE "api[_-]?key|secret|password|bearer |authorization: |-----BEGIN" \
  --include='*.md' --include='*.json' --include='*.ts' --exclude-dir=node_modules .
```

Result for both: no matches other than the negation statements themselves
and the documentation lines quoting these very commands (e.g. in this
file and in `/docs/conformance.md`).

## 3. Test results

Run at the end of this hardening pass:

```text
npm test

 ✓ test/core.test.ts (36 tests)
 ✓ test/schema-conformance.test.ts (11 tests)

 Test Files  2 passed (2)
      Tests  47 passed (47)
```

**Test count change: 25 → 47 (+22).** Breakdown of new coverage:

- Decimal-safe comparison (`compareDecimalStrings`): 4 new tests, including
  a case explicitly named for the classic 0.1/0.2 floating-point rounding
  hazard, and a large-magnitude precision case.
- `compareComparableValues` fail-closed rules: 5 new tests (number/number,
  money/money, currency mismatch → null, variant mismatch → null,
  timestamp/timestamp).
- `evaluateAcceptanceConstraints` monetary cases: 5 new tests — same-currency
  pass, same-currency fail, currency-mismatch fail-closed,
  incompatible-variant fail-closed, and a decimal-precision edge case
  (`20.01` against bounds at and just under that value).
  One additional test for a non-`ComparableValue`-shaped effect value
  failing closed.
- `assertReceiptCoversAllCommittedEffects`: 3 new tests (complete receipt
  passes, an omitted effect throws, an untrackable-but-present effect with
  `UNKNOWN` finality passes).
- `ReferenceProvider` full-lifecycle: 1 new test for a namespaced
  `RefusalReason` extension, 1 new end-to-end `INDETERMINATE` test
  (commit → INDETERMINATE → reconcile-by-idempotency-key, asserting no
  blind retry and no `committedEffects` on the indeterminate result), and 1
  new test proving the reference provider's `receipt()` itself cannot let a
  committed effect disappear even when a caller-supplied `onReceipt`
  override forgets one.
- Schema-conformance: 4 new fixture files (`acceptance-constraint.fixture.json`
  in each of the four domain examples) auto-discovered by the existing
  glob, each validated against the updated schema.

TypeScript: `npx tsc -p tsconfig.json --noEmit` — clean, no errors.

Schema: `npm run validate-schema` (now functional — see item 4 above) —
compiles under ajv strict mode, draft 2020-12, with no errors.

**Still not covered** (unchanged gap, explicitly named in
`/test/README.md`): no test exercises a *second* `commit()` call after
`INDETERMINATE` as a way of proving a naive retry would be unsafe/wrong at
the protocol level — the current test proves the *correct* path
(`reconcileIndeterminateCommit`) works, but does not additionally assert
what would go wrong if a caller ignored the spec and called `commit()`
again. This is a real gap in demonstrating the hazard, not just the
remedy, and is left as documented future work rather than added
speculatively in a pass scoped to not expand things further than
requested.

## 4. Dependency / license scan

Unchanged from the original pass: zero runtime dependencies in `src/core`.
`npm audit` still reports 5 vulnerabilities (3 moderate, 1 high, 1
critical), all transitive to `vitest`'s dev-server tooling
(`esbuild`/`vite`/`vite-node`), not shipped at runtime. Re-run in this pass
to confirm no change:

```text
5 vulnerabilities (3 moderate, 1 high, 1 critical)
```

Same as originally recorded — `npm install` was not re-run with updates in
this pass, since none were requested and doing so risks unrelated churn
during a focused hardening pass. Re-check immediately before publishing,
as before.

## 5. Secret / privacy scan

Re-run for this pass (see command and result under §2 above). Clean — no
matches beyond documentation/negation lines. No new fixtures introduced in
this pass contain anything beyond synthetic placeholder identifiers
(`order_8842`, `ABC123`, `sub_5591`, `ctr_2201` — unchanged from the
original pass; the new `acceptance-constraint.fixture.json` files
reference these same existing synthetic `quoteId`s, not new identifiers).

## 6. Remaining review risks

### BLOCKER

None identified. The single highest-priority gap from the original pass
(monetary constraints unenforceable) is resolved and verified with tests.

### NON-BLOCKER

1. **Concurrent-quote policy is still undefined** (ambiguities §5). Real
   risk for any adopter running multiple outstanding quotes against one
   resource, but appropriately left for external review rather than
   guessed at in this pass.
2. **`INDETERMINATE` hazard is demonstrated by its remedy, not by showing
   the failure of the naive alternative.** A sharp reviewer may ask for a
   test that shows what breaks if a caller does resubmit `commit()` blindly
   after `INDETERMINATE` (e.g. a duplicate `committedEffects` observation).
   Current tests prove the correct path works; they do not additionally
   prove the incorrect path is unsafe. Tracked in `/test/README.md`.
3. **The non-mutating-quote hold exception (§4) has no worked example.**
   The travel example still does not implement a disclosed hold, so the
   new normative rule permitting one is untested against real fixture
   data. Adding one was judged to be a feature addition (new effect type,
   new provider behavior) rather than a hardening fix, and was
   deliberately not done in this pass — flagged for a future, explicitly
   scoped pass instead.
4. **All validation remains self-consistency only.** As in the original
   pass: schema, reference implementation, and fixtures were all written
   by the same process. External/adversarial validation has not happened.
   See `/docs/falsification-notes.md`.
5. **UCP outreach has still not occurred.** Unchanged from the original
   pass.
6. **`npm audit` dev-tooling findings should be re-checked immediately
   before publishing**, as this scan has a shelf life (unchanged advice
   from the original pass).

## Recommendation

**PUBLISH.**

The one BLOCKER identified in the original pre-hardening readiness report
(monetary acceptance constraints unenforceable, the most commercially
obvious gap given the source brief's own examples) is resolved, tested (22
new tests, 47/47 passing), and does not expand MSE's scope — no domain
vocabulary was added, only a small, generic, discriminated comparable-value
shape. `INDETERMINATE` now has real end-to-end coverage including the
no-blind-retry behavior. Three further ambiguities were resolved minimally
without protocol redesign. TypeScript compiles clean, the schema compiles
clean under ajv strict mode, and the secret/vendor-endorsement scans are
clean. Remaining issues are all NON-BLOCKER and already were, or now are,
explicitly disclosed for reviewers rather than hidden. Per the source
brief's explicit instruction and this task's scope *as it stood at the
time this section was written*, **no push to a public repository had yet
been performed** — that recommendation was for the human decision-maker,
not an authorization to publish unilaterally. *(As noted at the top of
this document: the repository has since been published, following that
decision. This paragraph is preserved as originally written rather than
edited to look retroactively different.)*
