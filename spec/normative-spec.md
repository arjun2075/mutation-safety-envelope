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
that does not itself mutate `target`. Producing a quote MUST be a
non-mutating operation; a provider that mutates state merely by being asked
to quote a mutation is not conformant, regardless of what it names the
operation.

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
- otherwise the constraint is violated iff `effect.value operator
  constraint.value` is false.

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

A `Receipt` MUST report a `finality` for each effect the caller needs
tracked, using `EffectFinality`:

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

## 5. Open issues (non-normative until resolved)

These are known ambiguities in v0.1.0, tracked here rather than silently
resolved one way, so that external reviewers evaluate the same list the
maintainers see. See also [`/docs/ambiguities.md`](../docs/ambiguities.md)
for the fuller discussion each of these points expands from.

1. **`RefusalReason` extensibility.** The enum in v0.1.0 is closed. Profiles
   needing a more specific reason must currently overload
   `PROVIDER_REJECTED`. This is likely too restrictive for real providers
   and is expected to change before v1.0 — see ambiguities doc §1.
2. **Partial `effectReceipts`.** The spec permits a `Receipt` to report
   finality for a subset of a quote's effects "if others are not
   independently trackable," but does not define how a caller distinguishes
   "this effect is intentionally untracked" from "this effect's receipt was
   omitted by provider error." See ambiguities doc §2.
3. **Structured-value acceptance constraints.** `AcceptanceConstraint.value`
   is restricted to primitives, but most real effects (money) are naturally
   structured (`{amount, currency}`). v0.1.0 pushes the currency-aware
   comparison problem entirely into profiles. See ambiguities doc §3.
4. **What "quote" being non-mutating actually forbids.** Some providers
   place a soft, time-limited inventory hold as a side effect of quoting
   (common in travel). Is that a schema-level violation of "non-mutating,"
   or an acceptable side channel outside MSE's view? v0.1.0 does not say.
   See ambiguities doc §4.
5. **Multiple outstanding quotes against the same target.** The spec does
   not say whether a provider must track or reconcile several concurrently
   valid quotes against one `target`, or how `snapshot`-based drift
   detection interacts when two quotes are open at once. See ambiguities
   doc §5.
