# Ambiguities in the source handoff brief and v0.1.0 design

This document exists because the task that produced this repository
required surfacing ambiguity *before* publication, not resolving it
silently. Each item below states the ambiguity, the choice v0.1.0 made
(often "punt to a profile" or "leave underspecified"), and why the choice
is flagged rather than treated as settled.

---

## 1. `RefusalReason` is a closed enum

**Ambiguity:** The handoff brief gives illustrative refusal semantics
(`QUOTE_EXPIRED`, drift detection, constraint violation) but does not
specify whether refusal reasons are meant to be an extensible or closed
vocabulary.

**v0.1.0 choice:** Closed enum with five values
(`QUOTE_EXPIRED`, `SNAPSHOT_MISMATCH`, `CONSTRAINT_VIOLATED`,
`GUARANTEE_UNKNOWN_AT_COMMIT`, `PROVIDER_REJECTED`), with `PROVIDER_REJECTED`
as an overflow bucket.

**Why flagged:** This is very likely too restrictive. Real providers will
have refusal reasons MSE cannot anticipate (fraud hold, regulatory block,
account suspension, rate limiting). Collapsing all of them into
`PROVIDER_REJECTED` throws away information a caller might want to act on
differently (e.g. retry-worthy vs. not). The likely v0.2 fix is an
open/extensible string with a *recommended* core vocabulary, similar to how
OAuth's `error` parameter works — but that tradeoff (interoperability of a
closed set vs. expressiveness of an open one) is exactly the kind of thing
this repository is asking external reviewers to weigh in on, not something
resolved unilaterally here.

---

## 2. Partial effect receipts have no "why" signal

**Ambiguity:** The handoff brief and v0.1.0 schema both allow a `Receipt`
to report finality for a subset of a quote's effects. The stated rationale
("if others are not independently trackable") is reasonable, but nothing
in the schema lets a caller distinguish:

- "this effect is intentionally untracked by design" (fine), from
- "this effect's receipt was dropped due to a provider bug or partial
  outage" (not fine, and possibly hiding a real problem).

**v0.1.0 choice:** Left unresolved. `Receipt.effectReceipts` is just an
array; an empty or partial array is syntactically valid either way.

**Why flagged:** This is a real gap. A caller polling for finality on an
effect that never appears in any receipt has no schema-level way to tell
"stop waiting, it's not tracked" from "keep waiting, something is wrong."
A plausible fix is a required `effectReceipts` entry for every quoted
effect, with `finality: UNKNOWN` as the honest answer for "not
independently trackable," rather than omission. That was not adopted here
because it wasn't clear this was actually intended by the source brief,
and the task said to surface ambiguity rather than resolve it unilaterally.

---

## 3. Acceptance constraints can't natively express money

**Ambiguity:** The brief's own examples (`fare_delta <= USD 150`) are
currency-qualified amounts, but the brief also says the core "should
operate on primitive comparable value types rather than domain-specific
semantics."

**v0.1.0 choice:** `AcceptanceConstraint.value` is restricted to
`string | number | boolean`. A currency-qualified amount like `{amount:
"150.00", currency: "USD"}` cannot be expressed as a constraint bound
without a profile defining its own comparison semantics for that
`effectType` — which the schema explicitly permits but does not itself
specify.

**Why flagged:** This means every domain example in this repository
(retail, travel, subscription, contract) that wants to bound a monetary
effect cannot actually do so using the core `AcceptanceConstraint`
mechanism as written — they can only demonstrate the `Effect`/`Guarantee`
shape, not a working monetary bound. This is a real, load-bearing gap in
the core design and is arguably the single highest-priority open question
for external review: is "primitives only" the right invariant, or does the
core need a documented, minimal structured-comparison rule for at least
{amount, currency} pairs?

---

## 4. Undefined boundary around "quoting must not mutate"

**Ambiguity:** The brief states a `MutationQuote` is "a non-mutating
representation of the predicted consequences." Airline reshop systems
commonly place a short, soft inventory hold as a side effect of pricing a
reshop — arguably a mutation, arguably just caching.

**v0.1.0 choice:** The normative spec states quoting "MUST be a
non-mutating operation" without qualifying what counts as a mutation for
this purpose.

**Why flagged:** Under a strict reading, a provider that holds inventory
during quoting is non-conformant. Under a loose reading, almost anything
short of altering `target`'s durable commercial terms is fine. The travel
example in this repository (`/examples/travel`) sidesteps this by not
implementing the hold behavior at all — which avoids the question rather
than answering it.

---

## 5. Concurrent quotes against the same target are unaddressed

**Ambiguity:** Nothing in the brief or v0.1.0 says what happens if two
`MutationQuote`s are issued against the same `target` and both are still
valid (unexpired) when one of them is committed.

**v0.1.0 choice:** `commitConsistency: SNAPSHOT_REQUIRED` will cause the
*second* commit attempt to fail with `SNAPSHOT_MISMATCH` once the first
commit has changed the target's state — but only if the provider actually
updates the tracked snapshot on every mutating operation, including ones
that didn't go through MSE at all. The schema does not require this.

**Why flagged:** A provider that only updates its MSE-tracked snapshot on
MSE-issued commits, but not on other mutation paths into the same
resource, will silently fail to detect the exact class of drift
`commitConsistency` exists to catch. This is a correctness hazard for any
real integration and is not visible from the schema alone — it depends on
implementation discipline the spec currently only implies.
