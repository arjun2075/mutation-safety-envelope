# Ambiguities in the source handoff brief and v0.1.0-v0.3.0 design

This document exists because the task that produced this repository
required surfacing ambiguity *before* publication, not resolving it
silently. Each item below states the ambiguity, what was originally
chosen, and what was resolved and how, or why it remains open — across
the v0.1.0 hardening pass and the v0.2.0/v0.3.0 review revisions.

**Status as of v0.3.0:** All 5 originally-flagged v0.1.0 ambiguities are
resolved at the schema/spec level (§1-§5 below). External review (UCP
Discussion #799) additionally falsified two v0.1.0 design assumptions
(mutation-wide commit outcome; no INDETERMINATE resolution contract),
addressed in v0.2.0 — see
[`/docs/v0.2-review-response.md`](./v0.2-review-response.md) for the full
account. Later feedback separated cross-unit admission dependencies from
independent commit outcomes; §9 records the v0.3.0 resolution. Concurrent
quotes (§5), per-unit consistency policy (§7), genuinely shared effects
(§8), relation vocabulary breadth, and distributed admission/dispatch
concurrency remain open (see normative spec §8).

---

## 1. `RefusalReason` is a closed enum — **RESOLVED**

**Original ambiguity:** The handoff brief gives illustrative refusal
semantics but does not specify whether refusal reasons are meant to be an
extensible or closed vocabulary. v0.1.0 initially chose a closed enum with
`PROVIDER_REJECTED` as an overflow bucket, which was flagged as likely too
restrictive.

**Resolution:** `RefusalReason` is now a small standard vocabulary (the
same five reasons) **or** a namespaced extension string
`<namespace>:<local_reason>` (e.g. `travel:fare_class_closed`), using the
same namespacing convention `Effect.type` already uses. A provider SHOULD
use a standard reason when one applies and MUST prefer a namespaced
extension over overloading `PROVIDER_REJECTED` when it has more specific
information. See `/spec/normative-spec.md` §5. This is a schema-level
change (`RefusalReason` is now a `oneOf` in
`schema/mse-core.schema.json`), not a redesign — the five standard reasons
are unchanged and still the expected common case.

---

## 2. Partial effect receipts have no "why" signal — **RESOLVED**

**Original ambiguity:** A `Receipt` could report finality for a subset of
a quote's effects, with no way to distinguish "intentionally untracked"
from "silently dropped by provider bug."

**Resolution:** Fail-clear semantics: `Receipt.effectReceipts` MUST
contain exactly one entry for every effect committed across every unit
(as of v0.2.0: every effect in every `UnitResult.committedEffects` — see
`/spec/normative-spec.md` §6a; the field was `CommitResult.committedEffects`
in the original v0.1.0 resolution, before the v0.2.0 per-unit revision).
An untrackable effect MUST still appear, with `finality: UNKNOWN`, rather
than being omitted. Omission is now explicitly a conformance violation.
The reference implementation enforces this directly:
`ReferenceProvider.receipt()` back-fills any effect a
`DriftSimulator.onReceipt` override forgot with `finality: UNKNOWN` rather
than allowing an omission to reach the caller, and
`assertReceiptCoversAllCommittedEffects` in `/src/core/validate.ts` lets
any implementation check this mechanically (now across all units'
committed effects). See `test/core.test.ts`'s "receipt fail-clear" tests.

---

## 3. Acceptance constraints can't natively express money — **RESOLVED**

**Original ambiguity:** The brief's own examples (`fare_delta <= USD 150`)
are currency-qualified amounts, but `AcceptanceConstraint.value` was
restricted to bare primitives (`string | number | boolean`), so no domain
example could actually enforce a monetary bound end-to-end.

**Resolution:** `AcceptanceConstraint.value` (and any `Effect.value` a
profile wants to be constrainable) is now a `ComparableValue`: a closed,
discriminated set of generic value shapes —
`{type: "number"|"money"|"timestamp"|"boolean"|"string", ...}`. Recognizing
a monetary amount as "a decimal number plus a currency code" is
primitive-typing, not a domain concept (no fare/SKU/plan/refund vocabulary
was added), so this does not walk back domain-blindness. Money comparison
is fail-closed on both variant mismatch and currency mismatch, and uses
decimal-safe string arithmetic (`compareDecimalStrings` in
`/src/core/validate.ts`, BigInt-based, never a native float parse). See
`/spec/normative-spec.md` §4a for the full normative rule, and
`/examples/travel/acceptance-constraint.fixture.json` for the brief's own
`fare_delta <= USD 150` example now expressed as an enforceable
constraint.

**Was this the highest-priority gap?** Yes — this was flagged as the
single most load-bearing open question in the pre-hardening readiness
report, since it meant the most commercially obvious use case in the
source brief's own examples could not be demonstrated end-to-end. It is
resolved now, not merely worked around.

---

## 4. Undefined boundary around "quoting must not mutate" — **RESOLVED**

**Original ambiguity:** Airline reshop systems commonly place a short,
soft inventory hold as a side effect of pricing a reshop. It was unclear
whether this made a provider non-conformant under "quoting is
non-mutating."

**Resolution:** Quoting MUST NOT commit the requested commercial mutation
itself (i.e. it must not change the target's durable commercial terms). A
provider MAY create a temporary, reversible reservation or hold as a side
effect of quoting, but only if it is disclosed as an `Effect` in the quote
(e.g. `travel:inventory_hold`) and is genuinely self-reversing/expiring
without requiring a commit. An undisclosed or non-reversible hold remains
non-conformant. See `/spec/normative-spec.md` §3.1. The travel example
still does not implement hold behavior (out of scope for this pass, per
"do not expand MSE's scope" — adding a worked hold example would mean
adding a new effect type and provider behavior, which is a feature
addition, not a hardening fix), but the normative rule itself is no longer
ambiguous about what would be required if it did.

---

## 5. Concurrent quotes against the same target — **OPEN**

**Ambiguity:** Nothing in the brief or v0.1.0 says what happens if two
`MutationQuote`s are issued against the same `target` and both are still
valid (unexpired) when one of them is committed.

**Why this stays open:** The related snapshot-universality question (can
a provider only update its snapshot on MSE-issued commits and still claim
`SNAPSHOT_REQUIRED`?) has been narrowed by treating `snapshot` as
opaque/provider-defined with adapter-level documentation of drift
detection required (`/spec/normative-spec.md` §6) — but this only requires
providers to *state* their concurrency answer, it does not supply one.
Whether the core should additionally mandate a specific concurrent-quote
policy (e.g. "issuing a new quote against a target invalidates prior
outstanding quotes against the same target") is a genuine design question
that would need real-provider input to answer well, and resolving it
unilaterally here risks guessing wrong in a way that's expensive to walk
back post-v1.0. Deliberately left for external review rather than
resolved by fiat, per the explicit instruction not to expand scope or
redesign the protocol in this pass.

---

## 6. Mutation-wide commit outcome collapses multi-unit results — **RESOLVED in v0.2.0**

**Ambiguity/falsification:** v0.1.0's `CommitResult.outcome` was a single
mutation-wide scalar (`APPLIED`/`REFUSED`/`INDETERMINATE`). External
review (UCP Discussion #799) identified that a single mutation attempt can
legitimately span multiple independently committing units — e.g. one order
line applies while another is refused — and that a single scalar cannot
represent this without discarding real information.

**Resolution:** `MutationQuote.units: CommittingUnit[]` and
`CommitResult.unitResults: UnitResult[]` — one result per unit, with
complete-coverage enforcement (no silent omission) and an explicitly
non-authoritative `aggregateHint` convenience field. See
`/spec/normative-spec.md` §1a-§1c and
[`/docs/v0.2-review-response.md`](./v0.2-review-response.md) for the full
account. This is a breaking schema change, not an additive one — see
`/spec/normative-spec.md` §9 for the compatibility table.

---

## 7. INDETERMINATE had no normative resolution contract — **RESOLVED in v0.2.0**

**Ambiguity/falsification:** v0.1.0 told a caller not to retry
`INDETERMINATE` blindly but exposed no normative way to actually resolve
the uncertainty — only the reference implementation happened to have a
reconciliation helper, and nothing required any other implementation to
offer an equivalent.

**Resolution:** Every `INDETERMINATE` `UnitResult` now MUST carry a
`Reconciliation` object (`mode`: `MACHINE_RESOLVABLE` /
`AUTHORITATIVE_READ` / `NONE`, plus `correlationId` when a real path
exists). A binding exposing a real path MUST document how it is invoked,
how it correlates back to the original attempt, how its result maps to
the same unit, and that it resolves the prior attempt rather than
replaying the mutation. See `/spec/normative-spec.md` §4b-§4c. The
reference implementation demonstrates reconciliation resolving to
`APPLIED`, to `REFUSED`, and remaining unresolved — deliberately not
hardcoded to always succeed.

**New, narrower ambiguity surfaced by this resolution:** whether
`commitConsistency`/`snapshot` (§6 above) should be expressible per-unit
now that a quote can have multiple units with potentially different
consistency needs. v0.2.0 keeps `commitConsistency` at the whole-quote
level rather than guessing at a per-unit shape without real-provider
motivation. Left open — see `/spec/normative-spec.md` §8.

---

## 8. Cross-unit / shared effects — **OPEN (surfaced by v0.2.0)**

**Ambiguity:** v0.2.0's model assumes every `Effect` belongs to exactly
one `CommittingUnit`. It has no representation for an effect that is a
genuine joint consequence of more than one unit — for example, one
combined tax recalculation resulting from edits to two different order
lines in the same mutation attempt.

**Why this stays open:** Neither obvious fix is clearly correct without
real-provider input: arbitrarily assigning the shared effect to one unit
misrepresents causality (it implies that unit alone produced it), while
duplicating it across units under separate `effectId`s misrepresents one
effect as two. Resolving this without a concrete example of a real
provider actually needing to represent a cross-unit effect risks guessing
wrong in a way that would be expensive to walk back. See
`/spec/normative-spec.md` §7a and §8 for the normative discussion.

---

## 9. Independently committing did not mean independently admissible — **RESOLVED narrowly in v0.3.0**

**Ambiguity/falsification:** v0.2.0 fixed per-unit commit outcomes but had no
way to declare that one submitted unit transition depended on co-inclusion of
other transitions before any unit could be dispatched. `CommitRequest`
referenced only a fixed quote and could not carry an amendment.

**Resolution:** v0.3.0 adds a stable, directional
`REQUIRES_COINCLUSION` relation to `MutationQuote`, explicit opaque
transitions and binding-scoped unit locators on quoted units, and a distinct
pre-dispatch `AdmissionRefusal` with honest witness dispositions. A complete
witness constructs a new proposal and therefore a new quote. It never amends
the old quote, grants authorization, or changes per-unit commit outcomes.

This resolves only the two reported delivery gates modeled in the retail
binding. It does not resolve §8's genuinely shared-effect ownership problem,
define a generic constraint language, make co-included units atomic, or prove
that a distributed provider can close the check-to-dispatch gap without a
binding-specific transaction/revalidation mechanism.
