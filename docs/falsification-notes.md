# Evidence and falsification notes

**Status:** v0.2.0, external review candidate. This document is the honest
account of what has and has not been tested, aimed at reviewers whose job
is to find where MSE breaks — not to promote it.

**This document now records one round of real external falsification.**
UCP Discussion #799 identified two substantive problems with v0.1.0's
core (a mutation-wide commit outcome that couldn't represent independently
committing units, and an `INDETERMINATE` state with no normative
resolution path) — both accepted and addressed in v0.2.0. See
[`/docs/v0.2-review-response.md`](./v0.2-review-response.md) for the full
account. This is meaningfully more evidence than v0.1.0 had, but it does
not change the fundamental posture below: internal consistency is not
external validation, and the new v0.2.0 shapes (`CommittingUnit`,
`UnitResult`, `Reconciliation`, `effectId`) have themselves not yet been
externally reviewed — they are the current best response to the first
round of criticism, offered for a second round.

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
   EXACT-guarantee drift detection, and (as of v0.2.0) all three
   `UnitOutcome` values **per independently committing unit**, including
   mixed-outcome commit attempts (`APPLIED`+`REFUSED`, `APPLIED`+
   `INDETERMINATE` in the same `CommitResult`), plus a `PENDING` downstream
   effect and full reconciliation round-trips (`INDETERMINATE`→`APPLIED`,
   `INDETERMINATE`→`REFUSED`, and `INDETERMINATE`→still-unresolved) — via a
   from-scratch in-memory provider (`ReferenceProvider`) that holds no
   domain knowledge. 84 tests pass as of v0.2.0 (up from 47 at the end of
   the v0.1.0 hardening pass).
4. **Two real strict-mode schema bugs were found and fixed** during v0.1.0
   preparation (both in conditional `if`/`then` blocks in `CommitResult`),
   which is itself a small piece of evidence that the schema had not been
   mechanically validated before — a fact worth being explicit about
   rather than presenting the schema as more battle-tested than it is. No
   new strict-mode issues were found while authoring the v0.2.0 schema
   changes, for what that is worth (a smaller, less independently
   informative data point than item 4 originally was, since this revision
   was authored with the earlier lesson already in mind).
5. **One real round of external technical review has now occurred**
   (UCP Discussion #799), and both findings it raised were accepted and
   addressed rather than argued around — see
   [`/docs/v0.2-review-response.md`](./v0.2-review-response.md). This is
   the first evidence in this repository's history that did not originate
   from the same process that wrote the schema.

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
3. **The monetary-constraint gap was found and fixed in the v0.1.0
   hardening pass.** As documented in `/docs/ambiguities.md` §3, no domain
   example originally demonstrated a working `AcceptanceConstraint`
   against a currency-qualified amount. The core schema now expresses one
   via `ComparableValue` (spec §4a), with fail-closed currency/variant
   matching and decimal-safe comparison, tested in `test/core.test.ts`.
   This closes the single most load-bearing gap identified in the
   original readiness report; it does not by itself constitute external
   validation — see item 1 above, which still applies to the
   money-comparison logic as much as anything else in this repository.
4. **No performance, concurrency, or scale testing.** Nothing here says
   anything about behavior under concurrent quotes against the same
   target beyond the single-threaded `SNAPSHOT_REQUIRED` test in
   `test/core.test.ts`, which does not exercise actual concurrency. As of
   v0.2.0 this also applies to the new per-unit and reconciliation paths:
   nothing tests concurrent commit attempts against overlapping units, or
   concurrent reconciliation attempts against the same `correlationId`.
5. **No cross-language implementation.** Only a TypeScript reference
   implementation exists. The claim that the schema is "domain-blind" and
   portable has not been tested against a second language's type system or
   idioms, which could surface friction TypeScript's structural typing
   hides.
6. **UCP maintainer feedback has now occurred once** (UCP Discussion #799,
   addressed in v0.2.0 — see `/docs/v0.2-review-response.md`), but the
   `/ucp-binding` sketch itself remains a non-normative, unendorsed
   proposal, and the *new* v0.2.0 shapes this feedback produced
   (`CommittingUnit`, `UnitResult`, `Reconciliation`, `effectId`) have not
   themselves been reviewed by anyone outside this repository's own
   preparation process. Reporting "no UCP feedback yet" as this document
   once did would now be inaccurate; reporting the v0.2.0 shapes as
   externally validated would be equally inaccurate in the other
   direction.
7. **No test demonstrates what goes wrong under a genuine blind retry.**
   The reconciliation tests prove the *correct* path (read/status-check by
   `correlationId`) resolves without replay. Nothing here demonstrates the
   failure mode that path exists to prevent — e.g. a caller resubmitting
   `commit()` for an indeterminate unit and producing a duplicate
   `APPLIED` result. Proving the remedy works is not the same as proving
   the hazard is real in this reference implementation; see
   `/test/README.md` for this tracked as explicit future work.
8. **Cross-unit/shared effects are undemonstrated, not just
   undocumented.** `/spec/normative-spec.md` §7a and §8 document this as
   an open ambiguity, but no fixture or test attempts to construct one
   even as a negative example (e.g. showing what currently happens, or
   what a schema-conformant implementation is *not* required to handle,
   if a provider tried to represent a shared effect by duplicating it
   across two units). This gap is named rather than filled, consistent
   with the decision not to guess at a resolution.

## What would falsify the hypothesis

Concretely, evidence against the central hypothesis would look like:

- a real commercial mutation domain (beyond the four examined) that cannot
  be represented without adding domain-specific fields to `/schema` itself
  (not a profile);
- a real provider for which `EXACT` vs. `REVALIDATE` vs. `UNKNOWN` cannot
  capture an guarantee shape it actually needs to offer;
- a real integration where `INDETERMINATE` cannot be handled safely even
  with the v0.2.0 `Reconciliation` contract, because the underlying
  transport/protocol gives the caller no way to invoke or correlate a
  resolution attempt (this is exactly the class of finding UCP Discussion
  #799 already produced once against v0.1.0's weaker contract — a
  reviewer finding the v0.2.0 contract still insufficient would be a
  second, equally valid falsification);
- a real audit finding that "non-mutating quote" (§`/docs/ambiguities.md`
  §4) is unenforceable in practice for a majority of real providers, not
  just travel's soft-hold edge case;
- a real provider needing to represent an effect that is a genuine joint
  consequence of more than one `CommittingUnit`, which v0.2.0's
  one-effect-belongs-to-exactly-one-unit model cannot represent without
  either misattributing or duplicating it (`/spec/normative-spec.md` §7a);
- a real reconciliation implementation that cannot honestly satisfy
  §4b's four documentation requirements (invocation, correlation, result
  mapping, observe-not-replay) for a path it needs to expose, suggesting
  the contract's shape itself is insufficient rather than merely
  under-documented by a given binding.

Reviewers are explicitly invited to attempt any of the above and report
back, per the "falsification, not promotion" goal stated in the source
handoff brief.
