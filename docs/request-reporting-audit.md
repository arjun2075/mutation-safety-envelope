# Request reporting: verification and two audit passes

Base `main`: `b39cc8f9cb599f2550dc177a98f9f26eeae1d3b1`.
Local feature branch: `codex/request-admission-reporting`.
Audit date: 2026-09-07. These are two self-review passes, not independent
external certification. The reviewed branch may be committed and pushed for
review; no PR, tags, releases, or external discussion posts were created.

## Baseline and executable decision gate

Before core/schema edits, the base suite passed **142 tests in 3 files**;
TypeScript build, strict schema validation, and `git diff --check` passed.
The shell initially supplied unsupported Node 10.16.0/npm 6.9.0; installation
failed there. Verification used bundled **Node 24.19.0** and npm **11.6.0**
(downloaded into `/tmp/mse-npm`, invoked through its `npm-cli.js`). No project
dependency versions were changed to repair the runtime environment.

The added characterization then ran against core source extracted from the
recorded Git base: **2 cases passed**, observing **3 refusal/repair cycles,
4 quotes, and zero dispatch on each refusal**. Deleting independently failing
C from the exhaustive base response still passed the base validator. Only after
that reproduction and the [normative audit](request-reporting-design.md) was
required wire coverage introduced. The reproduction script continues to run
against the base, not an imitation or the changed working implementation.

## Pass 1 — semantic adversarial audit

| Attempt | Observed result and disposition |
| --- | --- |
| Omit C's failure while retaining FAILED coverage | Runtime validation rejects the contradiction. |
| Omit C from both failures and coverage | Runtime validation rejects incomplete quote coverage; provider throws before dispatch. |
| Claim PASSED for omitted C | Shape/correlation checks accept; actual merchant evaluation trace disproves the claim. This is an explicit binding trust limit, not proof of exhaustiveness by schema. |
| Claim C depends on A despite independence | Same structural limit; merchant trace rejects the invented dependency. |
| Fabricate B's result from hypothetical repair inputs | Dependent binding records no B read until the selector exists in a new proposal. A forged PASSED trace differs from the actual DEFERRED result; core cannot interpret opaque inputs. |
| Hide deferral with UNAVAILABLE | A DEFERRED entry cannot also have a failure. A missing evaluator now throws before dispatch instead of inventing an UNAVAILABLE witness. |
| Use cyclic/self/unknown/passed/duplicate dependency roots | Runtime rejects these constructions; schema rejects local shape and duplicate-list defects. Even a cycle with an additional failed root is rejected. |
| Use an acyclic C → B → A chain ending at FAILED A | Schema shape and runtime graph validation accept the legitimate multi-hop deferral. |
| Reorder coverage, failures, or multi-relation dependencies | Both original and reversed arrays validate; correlation uses relation identity, never array position. |
| Repeat a failure relation | Runtime rejects the duplicate even when both witnesses are structurally valid. |
| Interpret the union as permission | Goods-only permission fails for the amended proposal; the binding checks expanded permission before creating the new quote. |
| Interpret aggregate repair as atomic success | Fresh admission is followed by APPLIED, REFUSED, and INDETERMINATE in the same result. Reconciliation reads the previous attempt without another admission pass or timeout/dispatch-loop invocation. |
| Duplicate, contradict, or misattribute union transitions | Binding amendment rejects all three constructions. |

Concrete defects fixed in this pass: the missing-evaluator fallback conflated
unknown evaluation with known failure; coverage must be validated on successful
hooks too, or empty failures could bypass the new contract. Retail coverage
also refuses unknown rule IDs rather than accidentally labelling them PASSED.

The coverage promise is only for this pass and its binding state. The stable
three-order fixture admits after one union repair; the dependent fixture needs
two repairs. Neither establishes a general round-trip bound, authorization,
atomicity, or protection against concurrent state changes.

## Pass 2 — consistency audit

Compared the closed JSON Schema, TypeScript types, hook return contract,
reference provider, both test bindings, existing retail fixture, normative
§1d/§3.2/§9a, conformance docs, package and lockfile metadata, historical docs,
and actual runner counts.

- Schema and types require coverage, discriminate DEFERRED dependencies, and
  retain witness dispositions independently. Reference validation checks
  exactly-once declarations, FAILED/failure correspondence, and dependency
  roots before dispatch. The retail binding supplies actual evaluated coverage.
- Standard JSON Schema cannot enforce joins between arbitrary IDs in separate
  arrays/documents. Negative tests explicitly record which defects schema
  rejects and which require quote-aware runtime validation. No claim is made
  that schema alone rejects those semantic negatives.
- The existing retail refusal fixture now carries coverage and passes schema
  validation. Request-level and dependent messages generated in executable
  tests also pass the schema. Merchant/order vocabulary stays in the test
  binding; the single-order retail helper retains its scope checks.
- Package and root lockfile versions are `0.4.0-dev.0`; the schema ID and
  normative document identify the same unreleased revision. Current README
  and test documentation report 175, while historical v0.3 documents retain
  their historical 142 count. Historical compatibility prose now explicitly
  points to the superseding missing-evaluator behavior.
- The UCP update is an unsent draft. It distinguishes the supplied observation
  from this repository's proposed shape and does not assert adoption or a
  change to Weston's implementation.

## Safety regression evidence

| Property | Executable evidence |
| --- | --- |
| Zero dispatch on admission refusal | Batch, dependent, early-stop cases in `test/request-reporting.test.ts`; original retail tests |
| COMPLETE is relation/state local | Historical three-cycle case; original false-COMPLETE/fresh-state retail cases |
| All independent failures together | Three-order exhaustive case and omission negatives |
| Honest dependency deferral | A FAILED/B DEFERRED → A PASSED/B FAILED → both PASSED, with B read counters |
| New quote and authorization | Union amendment and dependent lifecycle use new proposal/quote IDs; goods-only authority is insufficient |
| Live state may introduce failure | Existing `admission.test.ts` fresh-state case; dependent new-input failure |
| Expiry/snapshot checks | Existing retail amended-quote expiry/snapshot tests and core quote-level tests |
| Per-unit determinacy | New aggregate-repair mixed result plus unchanged core per-unit coverage tests |
| Read-based reconciliation | New mixed case and unchanged core G/H/I cases |
| Effect finality remains distinct | Unchanged core J (APPLIED with PENDING effect), receipt coverage tests |

## Final verification

All commands below exited 0 after code/test changes:

| Command | Actual result |
| --- | --- |
| `npm test` | **175 passed, 4 files**: core 78, retail admission 24, schema 40, request reporting 33 |
| `npm run build` | TypeScript compilation passed |
| `npm run validate-schema` | AJV strict draft-2020-12 compilation passed |
| `npm run test:baseline` | **2 passed** against recorded v0.3.0 core; 3 cycles/4 quotes reproduced |
| `git diff --check` | Passed |

For this machine, prepend the bundled Node directory to PATH and invoke
`node /tmp/mse-npm/package/bin/npm-cli.js` in place of `npm`; the underlying
package scripts are identical. A normal supported Node/npm installation can
run the commands directly. `npm run test:baseline` requires the recorded base
Git object and installed development dependencies.

The two baseline characterization cases are **not included** in the 175-test
`npm test` result. They run separately because they compile against the
recorded v0.3.0 core contract. Across the two test invocations, exactly **177
test cases ran and passed**.

Remaining limitations: provider traces can lie, observational hooks can hide
side effects, and in-process validation is not a distributed lock. Coverage
cannot prove opaque domain semantics or bound future repairs. Deferral without
an identifiable failed-relation repair root is deliberately outside this narrow
representation and must fail before dispatch through the binding's error path.
