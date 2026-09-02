# Ambiguities in the source handoff brief and v0.1.0 design

This document exists because the task that produced this repository
required surfacing ambiguity *before* publication, not resolving it
silently. Each item below states the ambiguity, what v0.1.0 originally
chose, and — following a subsequent hardening pass — what was resolved and
how, or why it remains open.

**Status as of the hardening pass:** 4 of 5 originally-flagged ambiguities
are now resolved at the schema/spec level. One (concurrent quotes) remains
genuinely open. Resolutions are minimal and do not add domain scope — see
`/spec/normative-spec.md` §4a, §5, §6, §7 for the normative text.

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

**Resolution:** Fail-clear semantics: `Receipt.effectReceipts` MUST now
contain exactly one entry for every effect in `CommitResult.committedEffects`.
An untrackable effect MUST still appear, with `finality: UNKNOWN`, rather
than being omitted. Omission is now explicitly a conformance violation. See
`/spec/normative-spec.md` §7. The reference implementation enforces this
directly: `ReferenceProvider.receipt()` back-fills any effect a
`DriftSimulator.onReceipt` override forgot with `finality: UNKNOWN` rather
than allowing an omission to reach the caller, and
`assertReceiptCoversAllCommittedEffects` in `/src/core/validate.ts` lets
any implementation check this mechanically. See
`test/core.test.ts`'s "receipt fail-clear" tests.

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
