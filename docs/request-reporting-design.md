# Request-level admission reporting decision

Base: `main` at `b39cc8f9cb599f2550dc177a98f9f26eeae1d3b1`.
Branch: `request-admission-reporting`. No applicable AGENTS.md was found.

## Evidence before contract edits

With unchanged base core source, `node scripts/reproduce-v0.3.mjs` passes two
characterization cases: three independent orders need **3 refusal/repair
cycles and 4 quotes**, with locally COMPLETE witnesses and zero dispatches
on each refusal. The exhaustive evaluator returns three failures; deleting C
still passes the base refusal validator. This script extracts the recorded
core from Git into a temporary directory, so the reproduction remains runnable
after the working contract changes. It does not emulate the old validator.

## Normative audit and decision gate

1. §3.2 already says providers “MUST evaluate every applicable quote-declared”
   relation. Independent fail-fast evaluation violates that obligation even
   though the base reference provider and validator accept its response.
   `failures` already supports aggregation. No schema change is needed merely
   to return three independent failures together.
2. Quote + response + a trustworthy provider evaluation trace can establish
   whether every independent failure was reported. Quote + response alone
   cannot determine whether omitted C passed, was deferred, or was skipped.
   An intentionally false trace cannot be disproved by a domain-blind core.
3. A legitimate dependency cannot be reported as a known failure with
   UNAVAILABLE repair: the relation has not been evaluated. A wire-visible
   representation is needed for the requested caller distinction. Add required
   `coverage` entries naming every declared relation exactly once, with status
   PASSED, FAILED, or DEFERRED. Only DEFERRED carries nonempty `dependsOn`
   relation IDs. FAILED entries correspond exactly to failures. Omitted entries
   (including early stop) are invalid; there is no exhaustive boolean to trust.
   PASSED means evaluated with no failure. A relation declaring required pass
   evidence must also identify the participating satisfactions.
4. Coverage describes one admission evaluation pass of one quoted request at
   its evaluated binding state, not all future proposals or a locked snapshot.
   Independently evaluable relations MUST be evaluated in that pass. A deferred
   relation needs a real binding dependency on repair of another relation;
   dependencies must lead to a reported failure, with no cycles or passed roots.
   Coverage, failure, and dependency arrays are identity-correlated sets; their
   order has no semantic meaning.
5. Under unchanged independent fixture state, union repair needs one refusal
   round trip. No general round-trip bound follows: new state, newly activated
   dependencies, partial repairs, authorization, and later per-unit execution
   can prevent success. COMPLETE remains local to a relation and evaluated state.

No generic workflow language or domain vocabulary is added to core. The
reference hook must supply coverage even on a successful check. A missing hook
or malformed/incomplete coverage throws before dispatch; it cannot fabricate
failed relations with UNAVAILABLE witnesses. `CommitResult` remains unchanged,
but `COMMIT_RESULT` now carries a separate required `admissionReport`, making
successful evaluation reader-visible.

## Pass-satisfaction and successful-path correction

The retail delivery gates declare `passEvidence: REQUIRED`. Their PASSED
coverage carries a non-empty discriminated satisfaction list. A
`CURRENT_REQUEST` entry cites a quote-local `unitRef` and opaque transition; a
`PRIOR_FINAL_TRANSITION` entry cites the existing cross-quote `UnitLocator`,
opaque transition, stable transition reference, and `finalizedAt`. Both sources
may occur in one relation. No `NOT_APPLICABLE` status was added: a prior final
cancellation or redemption satisfies the gate.

Core validates source-exclusive fields, timestamps, scope/current-quote
correlation, and duplicate participants. The retail binding alone interprets
CANCEL/REDEEM and verifies historical truth. Only FINAL history qualifies.
Stale reads of monotonic final state fail closed by rejecting; premature
completion reporting can pass unsafely, so this narrows but does not solve the
general snapshot/check-to-dispatch problem.

## Execution-time realization of current-request evidence

The same finality rule has a second half on the current-request branch. At
admission a `CURRENT_REQUEST` satisfier has only been requested. Because
acceptance constraints come from the caller, a caller can refuse exactly that
unit and leave a `PASSED` record whose evidence the same response reports
`REFUSED`.

Two closures were available without atomicity. Ordered dispatch — a dependent
unit dispatching only after its satisfiers are `APPLIED`, and refused
otherwise — was rejected for core: it would turn `REQUIRES_COINCLUSION` into
an ordering primitive and change execution semantics to fix a reporting
defect. The chosen closure cross-checks `CURRENT_REQUEST` records against
`unitResults` and reports realization separately, so the pass is not read at
face value. Ordered dispatch remains a legitimate binding strategy, outside
core.

Admission-time `PASSED` is not overwritten, because the two facts differ:
"admitted because requested" and "realized after execution". Realization is
derived by validation from `coverage[].satisfactions` and
`commitResult.unitResults`, both already on the wire, following the
`aggregateHint` precedent of a non-authoritative derived summary with one
deterministic rule and a `compute`/`assert` pair. No field is added to the
admission entry, so a derived verdict cannot drift from the results it came
from.

Two smaller checks used data already present. A PASSED entry now states its
complete `requiredParticipants` set, and evidence must cover it exactly, which
rejects a pass citing one of two required goods cancellations. Prior-final
evidence must satisfy `finalizedAt <= evaluatedAt`, comparing two timestamps
that were both already on the report.

## Compatibility

Recommend and use **0.4.0-dev.0**, after the executable decision gate, because
required report coverage, the PASSED satisfaction union, relation evidence
declarations, required `requiredParticipants` on evidence-required passes, and
required successful-path `admissionReport` change the closed wire schema,
public TypeScript shape, and provider hook contract. The
`requiredParticipants` addition is additive in JSON Schema terms but a
**breaking tightening of the validation contract**: previously valid
development payloads that omit the set, state an incomplete set, or carry
prior-final evidence finalized after `evaluatedAt` now fail. Consumers also
acquire a normative correlation obligation (spec §3.2a). This is a
breaking pre-1.0 minor development revision, not a published release. v0.3.0
tags and historical documents remain unchanged. Migration: return actual
coverage for every declared relation; provide dependencies for deferred
evaluation; provide binding-required pass evidence; validate failure
correspondence; never derive PASSED merely from an incomplete failure list.
