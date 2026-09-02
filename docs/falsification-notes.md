# Evidence and falsification notes

**Status:** v0.1.0, external review candidate. This document is the honest
account of what has and has not been tested, aimed at reviewers whose job
is to find where MSE breaks — not to promote it.

The central hypothesis under test, per the source handoff brief:

> A small, domain-blind safety layer appears capable of representing the
> decision-safety semantics around heterogeneous commercial mutations while
> leaving business-domain behavior to existing systems.

The stated next milestone is external technical criticism, not more
features. This document is the current evidence base for that criticism to
work against.

## What has been checked in this repository

1. **Schema self-consistency.** `schema/mse-core.schema.json` compiles
   under ajv's strict-mode draft 2020-12 validator with no warnings (after
   two strict-mode issues found and fixed during this repository's own
   preparation — see git history / PR description for specifics).
2. **Cross-domain fixture conformance.** Four domain examples (retail,
   travel, subscription, contract/billing) — chosen because they are the
   four domains the source handoff brief explicitly says the abstraction
   was stress-tested against — each produce a `MutationQuote` fixture that
   validates against the core schema without requiring any core schema
   change to accommodate a domain. This is the strongest evidence in favor
   of the hypothesis currently in this repository.
3. **Reference-implementation behavioral tests.** `test/core.test.ts`
   exercises: fail-closed constraint evaluation (missing effect, `UNKNOWN`
   guarantee, violated bound, type-mismatched bound), quote expiry,
   EXACT-guarantee drift detection, and all three `CommitOutcome` values
   plus a `PENDING` downstream effect, via a from-scratch in-memory
   provider (`ReferenceProvider`) that holds no domain knowledge.
4. **Two real strict-mode schema bugs were found and fixed** while
   preparing this repository (both in conditional `if`/`then` blocks in
   `CommitResult`), which is itself a small piece of evidence that the
   schema had not been mechanically validated before — a fact worth being
   explicit about rather than presenting the schema as more battle-tested
   than it is.

## What has NOT been checked (gaps, stated plainly)

1. **No real provider integration.** Every check above runs against the
   in-repository `ReferenceProvider`, which is intentionally trivial and
   was written by the same process that wrote the schema. It cannot
   falsify the schema against a real system's constraints, because it has
   no constraints of its own beyond what the schema already encodes. This
   is the single largest gap between "internally consistent" and
   "externally validated."
2. **No adversarial or malicious-provider testing.** Nothing in this
   repository tests what happens when a provider lies (e.g. claims `EXACT`
   and then drifts anyway, or omits an effect specifically to dodge a
   constraint — see `/docs/security-considerations.md` §2). The
   `assertExactGuaranteesHonored` helper can *detect* this after the fact
   given both records, but nothing here tests detection under adversarial
   conditions at scale.
3. **The monetary-constraint gap was found, not fixed.** As documented in
   `/docs/ambiguities.md` §3, no domain example actually demonstrates a
   working `AcceptanceConstraint` against a currency-qualified amount,
   because the core schema cannot express one. This is a load-bearing
   unresolved question, not a cosmetic gap.
4. **No performance, concurrency, or scale testing.** Nothing here says
   anything about behavior under concurrent quotes against the same
   target beyond the single-threaded `SNAPSHOT_REQUIRED` test in
   `test/core.test.ts`, which does not exercise actual concurrency.
5. **No cross-language implementation.** Only a TypeScript reference
   implementation exists. The claim that the schema is "domain-blind" and
   portable has not been tested against a second language's type system or
   idioms, which could surface friction TypeScript's structural typing
   hides.
6. **No UCP maintainer feedback yet.** The UCP binding sketch
   (`/ucp-binding`) is unreviewed by anyone outside this preparation
   process. See `/docs/readiness-report.md`.

## What would falsify the hypothesis

Concretely, evidence against the central hypothesis would look like:

- a real commercial mutation domain (beyond the four examined) that cannot
  be represented without adding domain-specific fields to `/schema` itself
  (not a profile);
- a real provider for which `EXACT` vs. `REVALIDATE` vs. `UNKNOWN` cannot
  capture an guarantee shape it actually needs to offer;
- a real integration where `INDETERMINATE` cannot be handled safely even
  with an idempotency key, because the underlying transport/protocol gives
  the caller no way to reconcile state after receiving it;
- a real audit finding that "non-mutating quote" (§`/docs/ambiguities.md`
  §4) is unenforceable in practice for a majority of real providers, not
  just travel's soft-hold edge case.

Reviewers are explicitly invited to attempt any of the above and report
back, per the "falsification, not promotion" goal stated in the source
handoff brief.
