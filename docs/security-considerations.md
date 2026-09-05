# Security considerations

**Status:** v0.3.0, external review candidate. This is a first pass, not an
exhaustive threat model. Reviewers are explicitly invited to falsify or
extend it — see [`/docs/falsification-notes.md`](./falsification-notes.md).

MSE is a safety-*envelope*, not an authentication, authorization, or
transport protocol (see [`/spec/normative-spec.md`](../spec/normative-spec.md)
§1). Every consideration below assumes identity, auth, and transport
security are handled by whatever protocol MSE is composed with; MSE cannot
protect against their absence or failure.

## 1. A quote is not an authorization

An `EXACT` guarantee on an `Effect` is a promise about *what will happen if
committed*, not a statement that the caller is *authorized* to commit it. A
provider MUST perform its own authorization check on every `CommitRequest`
independent of anything in the quote. A client-supplied quote (or a quote
replayed from another session) MUST NOT be treated as an authorization
token.

## 1a. An admission witness is information, not authority

A `COMPLETE` witness can name additional transitions needed to repair one
relation. It does not prove that the caller may perform them. A binding MUST
authorize the amended proposal—including every added transition—before
issuing or committing its new quote. Providers SHOULD also consider whether
witnesses disclose scoped units or state that an unauthorized caller should
not be allowed to enumerate; authorization therefore belongs before any
externally visible admission evaluation in a real binding.

`unitLocator` is binding-scoped, not a bearer capability. Possessing a
locator or copying it into a proposal MUST NOT grant access to that unit.

## 1b. Completeness and state evidence must not become bypasses

Only `AdmissionWitness.disposition: COMPLETE` with a non-empty, unambiguous,
in-scope transition list can claim local repair for one failed relation.
`PARTIAL` is explicitly insufficient. `UNAVAILABLE` and `NOT_REPAIRABLE`
carry no transition list. Callers MUST NOT infer completeness from an omitted
or empty witness.

`evaluatedAt` and `stateRef` are correlation evidence, not locks. A caller
MUST obtain a new quote and the provider MUST evaluate current state again.
Bindings using external state need an atomic validation/dispatch boundary or
a final revalidation inside their own transaction; the synchronous reference
provider does not solve distributed concurrency.

An admission evaluator itself MUST be observational: dispatching a quoted
commercial transition from the hook would invalidate the no-dispatch meaning
of `ADMISSION_REFUSED`. Core code cannot detect a side effect hidden inside a
binding hook, so this is a binding conformance and audit obligation.

If dispatch may have occurred, returning `ADMISSION_REFUSED` would falsely
promise no mutation. The provider MUST instead preserve per-unit determinacy
and report `INDETERMINATE` plus reconciliation where the outcome is unknown.

## 2. Fail-closed constraint evaluation is a security property, not just a correctness one

§3.2 of the normative spec requires `AcceptanceConstraint` evaluation to
fail closed on a missing effect or an `UNKNOWN`-guaranteed effect. This
matters because an attacker (or a buggy provider) that omits an effect
entirely, rather than misreporting its value, could otherwise bypass a
constraint simply by not mentioning the effect it would violate. Any
implementation that treats "constraint references an effect not present in
the quote" as vacuously satisfied is not conformant and reintroduces this
bypass. As of v0.2.0, this applies to `effectId` lookups across every
unit in the quote (§7a) — a provider MUST search all units' effects, not
just one, before concluding an `effectId` has no match.

## 3. `INDETERMINATE` exists to prevent unsafe automatic retries

A caller that maps a unit's `INDETERMINATE` outcome to `REFUSED` and
retries that unit automatically can cause a duplicate real-world mutation
(double charge, double booking) for that unit specifically. A caller that
maps it to `APPLIED` and does nothing can leave a legitimate mutation
un-retried. Neither collapse is safe. Implementations MUST surface each
unit's `INDETERMINATE` outcome distinctly and MUST NOT auto-retry that
unit's commit without an explicit, separately-designed idempotency
mechanism (see `CommitRequest.idempotencyKey`, which MSE reserves but does
not itself define the semantics of). This is unchanged in substance by
v0.2.0's per-unit revision — the hazard now applies per unit rather than
to the whole mutation attempt, since other units in the same
`CommitResult` may already be cleanly `APPLIED` or `REFUSED`.

## 3a. Reconciliation is a new trust boundary, not a free pass

v0.2.0 adds a normative `Reconciliation` contract (see
`/spec/normative-spec.md` §4b-§4c) so a caller has a defined path to
resolve an `INDETERMINATE` unit. This introduces its own hazards that did
not exist in v0.1.0's schema (though they existed informally in any real
`INDETERMINATE` implementation):

- **A provider that claims `MACHINE_RESOLVABLE` or `AUTHORITATIVE_READ`
  without a real, working path is worse than one that honestly reports
  `NONE`.** A caller that trusts a `mode` it was told is actionable, and
  is not, may wait indefinitely on a reconciliation attempt that can never
  resolve, or may misinterpret a failed reconciliation *call* (e.g. a 404
  on a nonexistent endpoint) as a resolved `REFUSED` outcome for the
  underlying mutation. Implementations and reviewers should treat an
  unverified `mode` claim with the same skepticism as an unverified
  `EXACT` guarantee (§1) — both are promises a provider could make
  dishonestly or carelessly.
- **A reconciliation path that is secretly a replay is a bypass of the
  no-blind-retry guarantee it exists to provide.** §4c is explicit that
  reconciliation MUST be a read/status-resolution operation, never a
  resubmission of the mutation — but the schema cannot enforce this by
  itself; nothing in `Reconciliation`'s shape distinguishes a genuine
  status check from a binding that internally just calls `commit()` again
  under a different name. This is a documentation and conformance-review
  obligation (per §4b's four-point list a binding must satisfy), not
  something `schema/mse-core.schema.json` can verify mechanically.
- **`correlationId` values should be treated as sensitive.** A
  `correlationId` correlates back to a specific attempted mutation on a
  specific resource; depending on the binding, it may be usable to probe
  the state of that mutation. Implementations SHOULD treat it with
  similar handling care as a session or idempotency token, not log it in
  plaintext where a lower-trust reader could use it to query reconciliation
  state on someone else's behalf.

## 4. Snapshot/drift detection is only as strong as universal snapshot updates

As noted in [`/docs/ambiguities.md`](./ambiguities.md) §5, `SNAPSHOT_REQUIRED`
only detects drift if *every* mutation path into a resource updates the
tracked snapshot — not only mutations that went through MSE. A provider
that only checks MSE-issued commits against MSE-tracked snapshots, while
allowing other write paths to bypass that bookkeeping, has a
false-confidence gap: callers will believe drift detection is protecting
them when it is not protecting them from non-MSE writers.

## 5. Long-lived or missing `validUntil` on an `EXACT` guarantee

The schema permits an `EXACT` guarantee with no `validUntil` at all,
meaning the guarantee never expires on its own. This is intentionally legal
(some mutations really do have no natural expiry), but a provider offering
an unbounded `EXACT` guarantee on a market-sensitive value (e.g. a price)
is effectively offering an economic option with no time limit. Implementers
SHOULD treat an unusually long or absent `validUntil` on a market-sensitive
effect as something to actively decide about, not a default to fall into
by omission.

## 6. Opaque `target` and `change` fields are an intentional information-hiding boundary, and also an intentional trust boundary

Because `MutationProposal.target` and `MutationProposal.change` are opaque
to the MSE core, nothing in MSE itself validates their contents. A
provider MUST apply its own input validation to these fields exactly as it
would to any other untrusted input — MSE conformance provides no help here
and it would be a mistake to assume otherwise.

The same applies to v0.3.0's `CommittingUnit.transition` and
`RequiredTransition.transition`: the core preserves their presence and
correlation but cannot validate domain meaning. Core validation can reject a
wrong scope or repeated locator, but it cannot prove that a binding's
`COMPLETE` list is semantically complete. That promise is a binding/provider
conformance obligation and must be tested against real state rules.

## 7. This repository's own dependency posture

The reference implementation's devDependencies currently carry known
vulnerabilities in transitive build tooling (`esbuild`/`vite`, used only by
the `vitest` dev/test runner, not shipped in any published artifact — see
[`/docs/readiness-report.md`](./readiness-report.md)). These do not affect
`schema/mse-core.schema.json` or the `src/core` reference implementation at
runtime, but are recorded here for transparency rather than omitted.
