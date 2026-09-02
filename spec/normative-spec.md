# Mutation Safety Envelope (MSE) — Normative Specification

**Version:** v0.1.0
**Status:** Experimental / External Review Candidate
**Conformance to:** [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) keywords (MUST, SHOULD, MAY, etc.) are used as defined there.

> MSE is **not** an official specification of UCP, ACP, Shopify, Salesforce,
> IATA, Paid, Stripe, Paddle, Zuora, Chargebee, or any other vendor or
> standards body. It is an independent research proposal offered for
> external technical review. See [`/docs/DISCLAIMER.md`](../docs/DISCLAIMER.md).

The normative artifact is [`/schema/mse-core.schema.json`](../schema/mse-core.schema.json).
This document describes the rules that schema cannot express on its own,
and the design rationale behind the schema's shape. Where this document and
the schema disagree, treat that as a bug report against one of the two, not
as license to pick whichever is convenient — file an issue.

---

## 1. Scope

MSE defines the **safety envelope** around an agent-initiated mutation of
existing commercial state. It defines:

- how predicted effects of a mutation are represented and how much
  confidence attaches to each one (`Effect`, `Guarantee`);
- how a caller states the bounds it requires before accepting a mutation
  (`AcceptanceConstraint`);
- the three legal outcomes of attempting to commit a mutation
  (`CommitOutcome`);
- how downstream, not-yet-final consequences of a committed mutation are
  represented (`EffectFinality`, `Receipt`).

MSE does **not** define, and a conformant implementation MUST NOT claim
that adopting MSE alone provides:

- identity, authentication, or delegation of authority to act as a principal
- payment authorization or settlement
- transport (HTTP, gRPC, message queue, etc.)
- HTTP conditional request semantics (`If-Match`, `ETag`) — MSE's `snapshot`
  field is compatible with being *implemented via* such mechanisms, but MSE
  does not require or define them
- a generic idempotency-key system — `CommitRequest.idempotencyKey` reserves
  a field for one to be carried, nothing more
- order, subscription, travel, or any other domain resource schema
- inventory reservation, refunds, fulfillment, payment settlement, or
  procurement workflows

A conformant implementation MAY compose MSE with any of the above; it MUST
NOT present MSE itself as having solved them.

---

## 2. The three uncertainty windows

MSE's central design claim is that a single `SUCCESS`/`FAILURE` flag is
insufficient to describe an agent-initiated mutation of commercial state,
because it collapses three genuinely independent questions:

1. **Quote stability** — did the predicted effects drift between the time
   they were quoted and the time commit was attempted? (`Guarantee`,
   `MutationQuote.expiresAt`, `MutationQuote.snapshot`)
2. **Commit determinacy** — did the intended state transition actually
   apply, definitely not apply, or leave the caller unable to safely know
   which? (`CommitOutcome`)
3. **Effect finality** — for a mutation that did apply, have all of its
   downstream consequences (e.g. a refund, a re-issued document, a
   recalculated invoice) actually completed? (`EffectFinality`)

A conformant implementation MUST keep these three signals distinguishable
in its API surface. It MUST NOT, for example, represent `APPLIED` +
`refund: PENDING` as an overall failure, or paper over `INDETERMINATE` by
mapping it to either `APPLIED` or `REFUSED`.

---

## 3. Lifecycle

```text
MutationProposal → MutationQuote → CommitRequest → CommitResult → Receipt
```

### 3.1 MutationProposal → MutationQuote

A provider receiving a `MutationProposal` MUST return a `MutationQuote`
that does not itself commit the requested commercial mutation described by
`change`. Quoting MUST NOT be the mechanism by which the target resource's
durable commercial terms (price, quantity, plan, itinerary, contract terms,
etc.) actually change.

This does not forbid a provider from creating a temporary, reversible
reservation or hold as a side effect of quoting — for example, a short
inventory or seat hold common in travel reshop. Such a hold is compatible
with "quoting must not commit the mutation" **only if it is disclosed as an
Effect in the quote itself** (e.g. `travel:inventory_hold`), so the caller
can see it, and only if it is genuinely reversible/expiring on its own
without requiring a commit. An undisclosed hold, or one the provider cannot
or will not reverse if the quote is never committed, is not conformant —
it is a mutation wearing a quote's name. (This resolves the ambiguity
formerly tracked as open in `/docs/ambiguities.md` §4.)

Each `Effect` in the quote MUST carry a `Guarantee`. A provider MUST NOT
mark an effect `EXACT` unless it is actually prepared to honor that exact
value at commit time, subject only to `expiresAt`/`guarantee.validUntil`
and (if declared) `commitConsistency`. Marking an effect `EXACT` when the
provider cannot actually guarantee it is a conformance violation, not an
implementation detail — this is precisely the failure mode MSE exists to
make visible and rejectable.

### 3.2 MutationQuote → CommitRequest → CommitResult

Before committing, the caller MUST evaluate every `AcceptanceConstraint` it
holds against the quote's effects. Evaluation follows a **fail-closed**
rule:

- if an `AcceptanceConstraint.effectType` has no matching effect in the
  quote, the constraint is violated;
- if the matching effect's `guarantee.mode` is `UNKNOWN`, the constraint is
  violated, because the value cannot be relied on;
- if the matching effect's `value` is not shaped as a `ComparableValue` at
  all, the constraint is violated (see §4a) — a constraint can only be
  evaluated against a value the core knows how to compare;
- if the matching effect's `value` and the constraint's `value` are
  `ComparableValue`s of different `type` (variant), the constraint is
  violated (see §4a);
- if both are the `money` variant with different `currency`, the constraint
  is violated (see §4a);
- otherwise the constraint is violated iff `effect.value operator
  constraint.value` is false, evaluated per §4a's comparison rules.

This is a client-side check the caller SHOULD perform before ever sending a
`CommitRequest`, and a check a provider MUST also perform server-side
against the same acceptanceConstraints carried in the request — a client
check is not a substitute for provider enforcement, since a caller cannot
be trusted to have evaluated its own constraints honestly (or at all).

A provider processing a `CommitRequest` MUST return exactly one of:

- **`APPLIED`** — the mutation was applied. `committedEffects` MUST be
  present and MUST NOT differ from the quoted effects for any effect whose
  `guarantee.mode` was `EXACT`. (See §4.)
- **`REFUSED`** — the mutation was not applied. `refusalReason` MUST be
  present.
- **`INDETERMINATE`** — the provider cannot safely tell the caller whether
  the mutation applied (e.g. a network timeout after the request reached
  the backend). A caller receiving `INDETERMINATE` MUST NOT retry the
  commit as if it were a clean `REFUSED`, because a naive retry may cause a
  duplicate mutation. MSE does not define the retry-safety mechanism itself
  (see §1); it only requires the outcome to be surfaced so the caller can
  apply whatever idempotent-retry or reconciliation mechanism it has.

### 3.3 CommitResult → Receipt

A `Receipt` MUST report a `finality` for every committed effect, using
`EffectFinality`, per the fail-clear coverage rule in §7:

- **`FINAL`** — this effect's realized value will not change further.
- **`PENDING`** — this effect is still in flight (e.g. a refund queued but
  not yet settled).
- **`FAILED`** — this effect was expected to complete but did not, and will
  not be retried automatically by the provider merely because a `Receipt`
  was requested.
- **`UNKNOWN`** — the provider cannot currently determine this effect's
  state.

`mutationOutcome: APPLIED` together with one or more `effectReceipts`
showing `PENDING` or `FAILED` is a valid and expected receipt shape. A
provider MUST NOT infer or imply overall failure of the mutation from a
non-`FINAL` downstream effect, and MUST NOT imply overall success of every
downstream effect merely from `mutationOutcome: APPLIED`.

---

## 4. Guarantee semantics

| mode | meaning | caller may rely on value for AcceptanceConstraint evaluation? |
|---|---|---|
| `EXACT` | Provider guarantees this value will hold at commit, until `validUntil` (or indefinitely if absent) | Yes |
| `REVALIDATE` | Provider believes this value is currently accurate but may need to re-check it at commit time | No — see §3.2 fail-closed rule |
| `UNKNOWN` | No guarantee offered | No |

An `EXACT` guarantee is a promise, not a description of the provider's
confidence. A provider that is merely *fairly confident* but not actually
willing to honor drift as a conformance violation MUST use `REVALIDATE`,
not `EXACT`. This distinction is the entire point of the guarantee field;
diluting it defeats the purpose of the schema.

---

## 4a. Comparable values and monetary acceptance constraints

`AcceptanceConstraint.value` and any `Effect.value` a profile wants to be
constrainable are expressed as a `ComparableValue`: a closed, discriminated
set of generic value **shapes** —

```text
ComparableValue =
  | { type: "number"; value: number }
  | { type: "money"; amount: string; currency: string }
  | { type: "timestamp"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "string"; value: string }
```

This is a primitive-typing concern, not a domain concept. Recognizing that
a monetary amount is a decimal number paired with a currency code is no
more domain-specific than recognizing that a timestamp is a string in a
particular format; it does not encode anything about fares, SKUs,
subscription plans, or refund rules, and the core still assigns no meaning
to which `effectType` uses which variant. This resolves the ambiguity
formerly tracked as open in `/docs/ambiguities.md` §3 — it does not walk
back the domain-blindness rule described in §1, because no domain
vocabulary was added, only a small set of generic comparable-value shapes.

**Comparison MUST follow these rules, fail-closed:**

1. Two `ComparableValue`s are only comparable if they are the same variant
   (`type`). A `money` bound compared against a `number`-shaped effect
   value (or vice versa) is not comparable — the constraint MUST be treated
   as violated, not skipped or treated as vacuously true.
2. Two `money` values are only comparable if `currency` is identical
   (case-sensitive, ISO 4217). A currency mismatch MUST be treated as a
   violation, never as a unit-less numeric comparison of `amount` and never
   silently converted.
3. `money.amount` MUST be compared using decimal-safe arithmetic. An
   implementation MUST NOT parse `amount` into a native IEEE-754 float and
   compare the floats; doing so can misorder or misequate values a person
   would consider trivially exact (classic examples: `0.1 + 0.2 !== 0.3` in
   binary floating point). The reference implementation
   (`compareDecimalStrings` in
   [`/src/core/validate.ts`](../src/core/validate.ts)) demonstrates one
   correct approach: scale both amounts to a shared number of decimal
   places and compare as integers.
4. An effect whose `value` is not shaped as any `ComparableValue` variant
   cannot be constrained by the core mechanism at all. This is not an
   error by itself — many effects are legitimately non-constrainable
   opaque payloads — but any `AcceptanceConstraint` naming such an effect
   MUST be treated as violated (fail-closed), per §3.2.

This makes the brief's own motivating examples normatively enforceable,
e.g. `fare_delta <= USD 150` is now exactly:

```json
{
  "effectType": "travel:fare_delta",
  "operator": "<=",
  "value": { "type": "money", "amount": "150.00", "currency": "USD" }
}
```

against an effect shaped as
`{ "type": "money", "amount": "84.00", "currency": "USD" }` — see
[`/examples/travel/acceptance-constraint.fixture.json`](../examples/travel/acceptance-constraint.fixture.json).

---

## 5. RefusalReason: a small standard vocabulary plus namespaced extensions

`RefusalReason` is not a closed enum. A conformant value is **either**:

- one of five standard reasons: `QUOTE_EXPIRED`, `SNAPSHOT_MISMATCH`,
  `CONSTRAINT_VIOLATED`, `GUARANTEE_UNKNOWN_AT_COMMIT`, `PROVIDER_REJECTED`;
- **or** a namespaced extension string `<namespace>:<local_reason>` using
  the same namespacing convention as `Effect.type` (e.g.
  `travel:fare_class_closed`, `stripe:card_declined`).

A provider SHOULD use a standard reason when one genuinely applies, so
that callers written against only the standard vocabulary still get useful
signal. A provider MUST prefer a namespaced extension reason over
overloading `PROVIDER_REJECTED` when it has more specific information to
offer — collapsing everything into `PROVIDER_REJECTED` throws away
information a caller might reasonably act on differently (e.g. a
fraud-hold refusal is not retry-worthy in the way a rate-limit refusal
might be). This resolves the ambiguity formerly tracked as open in
`/docs/ambiguities.md` §1.

---

## 6. Snapshot and drift detection are provider-defined, not universal

`MutationQuote.snapshot` is opaque, provider-defined precondition material.
The core does not require:

- a single, shared snapshot/token scheme across providers or profiles;
- that every write path into a resource (not only MSE-issued commits)
  update the same tracked value.

A provider or adapter that declares `commitConsistency` other than `NONE`
MUST document, in its own adapter documentation (not in the core schema),
what `snapshot` actually contains and what mechanism detects drift against
it. This is a deliberate scope boundary, not an oversight: MSE standardizes
*that* a provider can declare a drift-detection consistency level and *what
the caller should expect* (`SNAPSHOT_REQUIRED` refuses on mismatch,
`SNAPSHOT_ADVISORY` does not), without standardizing *how* drift detection
is implemented, since that is inherently tied to each provider's own
storage and concurrency model. This resolves the ambiguity formerly
tracked as open in `/docs/ambiguities.md` §5 — by declaring the "universal
snapshot token" reading out of scope rather than requiring it, not by
requiring providers to solve a problem the core has no way to enforce
compliance with in the first place. **This remains a real integration
hazard for adopters** (see
[`/docs/security-considerations.md`](../docs/security-considerations.md)
§4): a provider whose own adapter documentation fails to actually cover
every write path has a false-confidence gap that no schema check can
catch.

---

## 7. Receipt coverage: fail-clear, not partial-by-default

A `Receipt.effectReceipts` MUST contain exactly one `EffectReceipt` for
every effect present in the corresponding `CommitResult.committedEffects`.
An effect MUST NOT silently disappear from the receipt. An effect that is
not independently trackable by the provider MUST still appear, with
`finality: UNKNOWN`, rather than being omitted.

Omitting a committed effect from `effectReceipts` is a conformance
violation, not a valid partial receipt. This resolves the ambiguity
formerly tracked as open in `/docs/ambiguities.md` §2, in favor of
fail-clear semantics: a caller polling for an effect's finality can now
rely on "absent from every receipt this quoteId ever produces" being
itself a conformance bug to report, rather than an ambiguous, possibly
intentional omission.

---

## 8. Open issues (non-normative until resolved)

Four of the five ambiguities originally tracked here were resolved in this
hardening pass (see §4a, §5, §6, §7 above, and
[`/docs/ambiguities.md`](../docs/ambiguities.md) for the full before/after
discussion of each). One remains genuinely open:

1. **Multiple outstanding quotes against the same target.** The spec does
   not say whether a provider must track or reconcile several concurrently
   valid quotes against one `target`, or how `snapshot`-based drift
   detection interacts when two quotes are open at once. §6's resolution
   (snapshot is provider-defined, adapters document their own drift
   detection) narrows this somewhat — a provider's documented mechanism is
   now expected to state its own answer — but the core still does not
   mandate any particular concurrent-quote policy. See ambiguities doc §5
   for the fuller discussion, kept open pending real-provider feedback.
