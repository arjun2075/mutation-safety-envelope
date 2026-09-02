# Security considerations

**Status:** v0.1.0, external review candidate. This is a first pass, not an
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

## 2. Fail-closed constraint evaluation is a security property, not just a correctness one

§3.2 of the normative spec requires `AcceptanceConstraint` evaluation to
fail closed on a missing effect or an `UNKNOWN`-guaranteed effect. This
matters because an attacker (or a buggy provider) that omits an effect
entirely, rather than misreporting its value, could otherwise bypass a
constraint simply by not mentioning the effect it would violate. Any
implementation that treats "constraint references an effect not present in
the quote" as vacuously satisfied is not conformant and reintroduces this
bypass.

## 3. `INDETERMINATE` exists to prevent unsafe automatic retries

A caller that maps `INDETERMINATE` to `REFUSED` and retries automatically
can cause a duplicate real-world mutation (double charge, double booking).
A caller that maps `INDETERMINATE` to `APPLIED` and does nothing can leave
a legitimate mutation un-retried. Neither collapse is safe. Implementations
MUST surface `INDETERMINATE` distinctly and MUST NOT auto-retry a commit
carrying the same effects without an explicit, separately-designed
idempotency mechanism (see `CommitRequest.idempotencyKey`, which MSE
reserves but does not itself define the semantics of).

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

## 7. This repository's own dependency posture

The reference implementation's devDependencies currently carry known
vulnerabilities in transitive build tooling (`esbuild`/`vite`, used only by
the `vitest` dev/test runner, not shipped in any published artifact — see
[`/docs/readiness-report.md`](./readiness-report.md)). These do not affect
`schema/mse-core.schema.json` or the `src/core` reference implementation at
runtime, but are recorded here for transparency rather than omitted.
