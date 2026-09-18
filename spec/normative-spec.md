# Mutation Safety Envelope (MSE) — Normative Specification

**Version:** v0.4.0-dev.0
**Status:** Experimental / Unreleased development revision
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

**v0.4.0-dev.0 adds required admission evaluation coverage and wire-visible
pass-satisfaction evidence**, a breaking
pre-1.0 revision of v0.3.0. Independent aggregation was already required by
§3.2; the new representation distinguishes evaluated results from legitimate
dependency deferral. See [the executable decision gate](../docs/request-reporting-design.md)
and §9a. The v0.3.0 tag and prerelease are unchanged.

**v0.3.0 is a breaking revision of v0.2.0.** It retains v0.2.0's
per-unit outcomes and read-based reconciliation, and adds the separate
pre-dispatch admission boundary motivated by later comments in UCP
Discussion #799. See
[`/docs/v0.3-review-response.md`](../docs/v0.3-review-response.md) and the
design decision in
[`/docs/v0.3-design-decision.md`](../docs/v0.3-design-decision.md).
These changes are proposed MSE design work, not accepted UCP requirements
or evidence of adoption. §9 classifies the v0.2.0 → v0.3.0 break.

---

## 1. Scope

MSE defines the **safety envelope** around an agent-initiated mutation of
existing commercial state. It defines:

- how a mutation attempt decomposes into independently committing units,
  and how predicted effects of each unit are represented with attached
  confidence (`CommittingUnit`, `Effect`, `Guarantee`);
- how a quote declares directional cross-unit admission relations and how
  a known pre-dispatch failure reports an honest repair witness
  (`AdmissionRelation`, `AdmissionReport`, `AdmissionRefusal`);
- how a caller states the bounds it requires before accepting a mutation
  (`AcceptanceConstraint`);
- the three legal per-unit outcomes of attempting to commit a mutation,
  and how a caller resolves an indeterminate one (`UnitOutcome`,
  `Reconciliation`);
- how downstream, not-yet-final consequences of a committed unit are
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

## 1a. Independently committing units

External review (UCP Discussion #799) established that a single mutation
attempt commonly spans multiple parts that can each succeed, fail, or be
left indeterminate independently of the others — e.g. one order line
applies while another is refused, or one travel segment applies while
another times out downstream. v0.1.0's single mutation-wide `CommitOutcome`
could not represent this without collapsing real, distinct committed state
into one scalar. This is treated as a successful falsification of a
v0.1.0 assumption, not defended.

A `MutationQuote` therefore carries `units: CommittingUnit[]` — the
complete set of independently committing units this quote proposes,
**known no later than quote time**. Each `CommittingUnit` has:

- an opaque, stable `unitRef`, unique within the quote;
- a binding-scoped `unitLocator` that can identify the same domain unit
  across a failure witness and a separately generated quote;
- an opaque, binding-defined `transition` describing what this unit would
  dispatch;
- its own `effects: Effect[]`.

The core assigns **no domain meaning** to what a unit is. A unit MAY
correspond to a retail order line, a travel segment, a subscription
component, a contract clause, or anything else a profile/provider defines
— the core only requires the shape, not the semantics. A quote with a
single unit is the fully valid degenerate case; v0.3.0 does not require
multi-unit quotes, only that the shape can represent them when they occur.

A provider MUST NOT invent a unit identity only after execution — the
purpose of fixing `unitRef`s at quote time is so a caller can check result
coverage (§1b) against a set it already saw *before* committing, not
discover the set only from the result.

Every `unitRef` and every `(unitLocator.scopeRef, unitLocator.unitKey)`
pair within a quote MUST be unique. `unitRef` is quote-local: callers MUST
NOT assume it identifies the same domain unit in a later quote. A
`unitLocator` is stable only according to the binding's declared
`scopeRef`; it is not a globally portable identity. A provider producing
a quote with a duplicate identity is not conformant; see
[`assertQuoteUnitsWellFormed`](../src/core/validate.ts).

---

## 1b. Complete coverage: a unit MUST NOT be silently omitted

A `CommitResult` carries `unitResults: UnitResult[]`, and **MUST contain
exactly one `UnitResult` per `CommittingUnit` present in the quote it
responds to** — no more, no fewer, no duplicates, and no reference to a
`unitRef` absent from that quote.

A provider MUST NOT silently omit a unit from `unitResults`. Concretely,
this means:

- `unitResults.length` MUST equal `quote.units.length`;
- the set of `unitRef`s in `unitResults` MUST equal the set of `unitRef`s
  in `quote.units`, exactly;
- a `unitRef` MUST NOT appear more than once in `unitResults`.

This is the mechanism by which a caller knows it has seen a result for
every unit it was quoted, without having to trust an aggregate summary
(§1c) to have counted correctly. The reference implementation's
[`assertCommitResultCoversAllUnits`](../src/core/validate.ts) checks all
three conditions and throws `MseViolation` naming the specific coverage
defect found (missing unit, duplicate unit, or unknown unit reference).

---

## 1c. No mutation-wide outcome; `aggregateHint` is non-authoritative

v0.2.0 removes the v0.1.0 mutation-wide `CommitResult.outcome` field
entirely — see §9 for the exact list of removed/renamed fields. There is
no scalar "did the mutation succeed" answer at the `CommitResult` level.
A `CommitResult` that mixes `APPLIED` and `REFUSED` units, or `APPLIED`
and `INDETERMINATE` units, in the same commit attempt is not an edge case
to special-case — it is the normal shape the schema is built around.

`CommitResult` MAY carry `aggregateHint`, a **non-authoritative, purely
derived** convenience field: `ALL_APPLIED`, `ALL_REFUSED`,
`ALL_INDETERMINATE`, or `MIXED`. There **is** a single deterministic
derivation rule (this is not left open): `ALL_APPLIED` iff every
`unitResults[].outcome` is `APPLIED`, `ALL_REFUSED` iff every one is
`REFUSED`, `ALL_INDETERMINATE` iff every one is `INDETERMINATE`, `MIXED`
otherwise. An implementation computing this field MUST use exactly this
rule and MUST NOT let a present `aggregateHint` disagree with what it
derives from `unitResults`. The reference implementation exposes this
rule as a checkable pair — `computeAggregateHint` (the derivation itself)
and `assertAggregateHintConsistent` (which throws if a present hint
disagrees with it) in
[`/src/core/validate.ts`](../src/core/validate.ts) — and `ReferenceProvider`
uses `computeAggregateHint` to populate every `aggregateHint` it emits, so
it cannot itself produce a contradictory one.

A caller **MUST NOT** treat `aggregateHint` as a substitute for inspecting
`unitResults`, and **MUST NOT** collapse a `MIXED` result into any single
APPLIED/REFUSED/INDETERMINATE decision. `aggregateHint` exists only to let
a caller fast-path the common case (a single-unit quote, or a uniform
outcome across all units) without inspecting every entry; it carries no
information `unitResults` does not already carry, and a provider MAY omit
it entirely. Having a deterministic derivation rule does not make the
field authoritative — it only means that *if* a provider chooses to emit
it, there is exactly one correct value it is allowed to emit, and a
provider emitting anything else has produced a non-conforming
`CommitResult`.

---

## 1d. Directional admission relations are not atomic commit groups

A `MutationQuote` carries `admissionRelations: AdmissionRelation[]`, which
MUST be present and MAY be empty. v0.3.0 defines one deliberately narrow
relation type: `REQUIRES_COINCLUSION`.

The relation is directional. Its `triggerUnitRefs` name quote-local units
whose proposed transitions may require additional transitions from
`scopeRef` to be present in an admissible proposal. Every trigger MUST
resolve to a unit in the same quote, and that unit's
`unitLocator.scopeRef` MUST equal the relation's `scopeRef`.

The relation declaration is stable quote material. It MUST NOT embed a
quote-time list of currently missing units. Domain operations, resource
states, and the rule deciding which scoped units are currently required
belong to the binding. The binding evaluates those semantics against live
state at admission (§3.2).

`REQUIRES_COINCLUSION` means only that transitions must be submitted
together to pass a pre-dispatch gate. It does **not** make the units an
atomic transaction. Once admission passes, each unit still receives its
own `UnitResult`; one can be `APPLIED` while a required companion is
`REFUSED` or `INDETERMINATE`. A binding that must prevent that economic
outcome needs a stronger execution/transaction guarantee outside this
relation.

This remains true when the companion is the unit a `PASSED` entry cited as
its satisfier. A satisfying transition that ends `REFUSED` or
`INDETERMINATE` does not retroactively invalidate admission and does not
refuse the dependent unit. It does mean the satisfaction was not realized,
which §3.2a requires the response to make visible rather than prevent.

---

## 2. The three uncertainty windows

MSE's central design claim is that a single `SUCCESS`/`FAILURE` flag is
insufficient to describe an agent-initiated mutation of commercial state,
because it collapses three genuinely independent questions. As of v0.3.0,
the second question is itself now per-unit rather than mutation-wide (see
§1a-§1c):

1. **Quote stability** — did the predicted effects drift between the time
   they were quoted and the time commit was attempted? (`Guarantee`,
   `MutationQuote.expiresAt`, `MutationQuote.snapshot`)
2. **Commit determinacy, per unit** — for each independently committing
   unit, did the intended state transition actually apply, definitely not
   apply, or leave the caller unable to safely know which?
   (`UnitResult.outcome`)
3. **Effect finality** — for a unit that did apply, have all of its
   downstream consequences (e.g. a refund, a re-issued document, a
   recalculated invoice) actually completed? (`EffectFinality`) — see §6a
   for why this remains distinct from commit determinacy even now that
   determinacy is per-unit.

A conformant implementation MUST keep these three signals distinguishable
in its API surface, now at the unit level for determinacy. It MUST NOT,
for example, represent a unit's `APPLIED` outcome plus a `PENDING`
downstream effect as an overall failure of that unit, paper over a unit's
`INDETERMINATE` outcome by mapping it to either `APPLIED` or `REFUSED`, or
collapse a mixed set of `unitResults` into one summary that discards which
units actually applied.

Admission validity is an additional **pre-dispatch gate**, not a fourth
commit outcome and not a fourth effect guarantee. A known
`ADMISSION_REFUSED` response proves that this submission dispatched no
commercial mutation. If dispatch may have occurred, the provider MUST use
the per-unit determinacy model (including `INDETERMINATE` and
reconciliation) instead of reporting a clean admission refusal.

---

## 3. Lifecycle

```text
MutationProposal → MutationQuote → CommitRequest → CommitResponse
       ▲                                      ├─ ADMISSION_REFUSED
       │                                      │    └─ witness → new proposal → new quote
       │                                      └─ COMMIT_RESULT → Receipt
       │                                              └─ Reconciliation (per INDETERMINATE unit)
       └──────────────────── amendment always re-enters here
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
it is a mutation wearing a quote's name.

Each `Effect` in the quote MUST carry a `Guarantee` and a unique
`effectId` (see §7a). A provider MUST NOT mark an effect `EXACT` unless it
is actually prepared to honor that exact value at commit time, subject
only to `expiresAt`/`guarantee.validUntil` and (if declared)
`commitConsistency`. Marking an effect `EXACT` when the provider cannot
actually guarantee it is a conformance violation, not an implementation
detail — this is precisely the failure mode MSE exists to make visible
and rejectable.

Each quote MUST also preserve the opaque `transition` associated with
every `CommittingUnit` and a binding-scoped `unitLocator`. The provider
MAY retain the originating proposal internally (the reference provider
does) so a binding hook can evaluate the exact submitted transition set.
Core code MUST NOT parse transition/domain state vocabulary. The quoter
and binding are responsible for mapping `MutationProposal.change` into
quoted units, locators, transitions, effects, and relation declarations.

### 3.2 MutationQuote → CommitRequest → CommitResponse

Before committing, the caller MUST evaluate every `AcceptanceConstraint` it
holds against the quote's effects. As of v0.2.0, a constraint names its
target effect by `effectId` (see §7a), not `type`. Evaluation follows a
**fail-closed** rule:

- if an `AcceptanceConstraint.effectId` has no matching effect anywhere in
  the quote (in any unit), the constraint is violated;
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

Before returning a correlated commit result and before dispatching any commercial
mutation, a provider MUST evaluate every independently evaluable applicable
quote-declared `AdmissionRelation` against the submitted transitions and current
binding state. It MUST report all failures discovered in that pass together.
Fail-fast over independent relations violates this requirement (also present
in v0.3.0). A genuinely repair-dependent relation MAY be deferred only under
the coverage rules below. The evaluation itself MUST be observational with
respect to the commercial mutation: a binding MUST NOT dispatch any quoted
transition from inside an admission evaluator. A provider MAY evaluate several
relations together, but a returned failure for one relation MUST NOT claim that
repairing it makes every other relation—or the whole request—admissible.

`CommitResponse` has exactly one branch:

- `ADMISSION_REFUSED` carries an `AdmissionRefusal` and means this
  submission dispatched **no** commercial mutation;
- `COMMIT_RESULT` carries both an `AdmissionReport` and the v0.2.0
  `CommitResult`. The report concerns admission; the result retains unchanged
  complete per-unit execution coverage and determinacy semantics.

An `AdmissionReport` MUST correlate to the evaluated `quoteId` and the
originating `proposalId`, carry an ISO 8601 `evaluatedAt`, and carry `failures`
and `coverage`. Its optional `stateRef` is opaque evidence of evaluated state;
neither it nor `evaluatedAt` is a lock. `AdmissionRefusal` is the
failure-bearing specialization and MUST contain at least one failure. A
`COMMIT_RESULT` report MUST contain no failures. A known quote with no declared
relations still carries an empty report, so omission cannot hide whether the
admission boundary ran.

Every `AdmissionReport` MUST carry `coverage`, with exactly one
`AdmissionCoverage` entry per quote-declared relation, including relations
found inapplicable by evaluation. Entries MUST use one of:

- `PASSED`: evaluated at this pass's state and did not fail. A relation whose
  quote declaration carries `passEvidence: REQUIRED` MUST also carry a
  non-empty `satisfactions` list, so its pass cannot be an unexplained absence
  of failure, and MUST carry a non-empty `requiredParticipants` set stating
  the complete participant set that evaluation required. Other relation
  classes MAY define inapplicability as a pass without satisfaction records.
- `FAILED`: evaluated and failed; exactly one matching `failures` entry MUST
  exist. Every failure MUST have exactly one FAILED coverage entry.
- `DEFERRED`: applicable, but evaluation requires repair of another relation
  in a new proposal/state. It MUST carry nonempty, unique `dependsOn` relation
  IDs and MUST NOT carry a failure witness for the unevaluated relation.

Only DEFERRED entries may carry `dependsOn`. Each dependency MUST name another
quote-declared relation and MUST be a genuine binding dependency on its repair,
not a provider's preferred iteration order. Dependency paths MUST terminate
in a reported FAILED relation; cycles, self references, and PASSED dependencies
are invalid. Dependencies express only the reason for deferral in this pass,
not a generic execution workflow or an instruction to dispatch repairs.

Each `AdmissionSatisfaction` is one branch of a closed discriminated union:

- `CURRENT_REQUEST` carries the participating quote-local `unitRef` and the
  opaque transition from that quoted unit. It MUST NOT carry historical
  finality or correlation fields.
- `PRIOR_FINAL_TRANSITION` carries the participating binding-scoped
  `unitLocator`, opaque transition, stable non-empty `transitionRef`, and ISO
  8601 `finalizedAt`. It MUST NOT carry a quote-local `unitRef`.

Transitions are opaque to the core. Where this specification requires two
transitions to be equal, the comparison MUST be **structural**: JSON object
member order is a serialization detail and MUST NOT affect identity, while
array order remains semantic. An implementation MUST NOT compare transitions
by naive serialization, and MUST NOT interpret any field inside one.

Every participant MUST belong to the relation's declared scope. A
current-request transition MUST match the cited quoted unit. One relation MUST
NOT repeat satisfaction for the same binding-scoped unit, including once from
each source. This supports all-current, all-prior, and mixed satisfaction
without assigning domain meaning to an operation or state.

`requiredParticipants` states the complete participant set the relation
required at this evaluation pass. It belongs on the coverage entry rather than
the quote declaration because the satisfying set is live state resolved at
admission, not stable quote material (§1d). Each entry names a binding-scoped
`unitLocator` within the relation's declared scope plus the opaque
`transition` that participant had to contribute. Duplicate participants, an
empty set, and out-of-scope participants are invalid; the field MUST NOT
appear on a FAILED or DEFERRED entry.

A required participant is the pair **(`unitLocator`, `transition`)**, not a
locator alone. One relation MUST NOT state two required transitions for the
same binding-scoped unit, so duplicate detection is locator-keyed, but the
declared transition is part of what must be satisfied.

When `requiredParticipants` is present, `satisfactions` MUST cover it
**exactly**. Every required participant MUST have a satisfaction record whose
locator matches it **and** whose `transition` is structurally equal to the
transition that participant was required to contribute. No record may cite a
participant outside the set. A `PASSED` entry citing only a subset of its
required participants is invalid, and evidence for the right unit carrying a
different transition does **not** cover that participant: a satisfaction for
one transition never discharges a requirement for another, even on the same
unit. Without this, a pass that cites one of two required participants, or
substitutes a different transition, is indistinguishable on the wire from a
complete one.

### What core can and cannot establish here

Core checks **internal correspondence**: that the stated set is well formed,
that evidence matches it exactly by unit and transition, and that no record
cites a transition other than the one required. It does not and cannot
check that the stated set is the *semantically complete* set the relation
actually required.

Core MUST NOT infer relation participation from shared scope. `scopeRef`
declares where a locator is **resolved**; it does not assert that every
transition inside that scope participates in every relation. A quote may
legitimately carry an unrelated same-scope transition — for example a cancel
on one unit alongside a redeem gate on another — and that unit is not a
participant in the redeem relation. An implementation that treated every
same-scope non-trigger quoted unit as required would reject conforming
proposals, including the amended proposal a binding's own `COMPLETE` witness
produces.

The current `AdmissionRelation` declaration carries `triggerUnitRefs` and
`scopeRef` but **no participant basis**, so the required set is not derivable
from the quote. This is an accepted boundary of this revision, not an
oversight. Consequently a producer that omits a participant from both
`requiredParticipants` and `satisfactions` leaves the two arrays mutually
consistent, and core cannot disprove it.

**Binding trace conformance MUST therefore validate that
`requiredParticipants` equals the set the declared relation actually required
at the evaluated state.** Semantic completeness of the stated set is a
binding obligation unless and until a future revision gives the quote
relation an explicit participant basis. The retail binding discharges it by
re-evaluating its gates against real state and comparing full coverage,
including the stated participant sets.

#### Prior-final evidence may coexist with current activity on the same unit

A `PRIOR_FINAL_TRANSITION` record MAY cite a `unitLocator` that the current
quote also carries, **including with the same opaque `transition` value**.
Validation MUST NOT reject a record on either ground.

The reason is what identifies a historical occurrence. `unitLocator`
identifies the domain unit. `transition` is an opaque operation value whose
meaning is binding-owned, and this specification nowhere declares
transitions unique or non-repeatable for a unit. `transitionRef` is the
field that identifies the occurrence. A unit supporting a repeatable
operation may therefore have a genuinely final occurrence in its history
and a freshly requested transition of the same shape in this quote; the two
are distinct events, and the current one failing says nothing about the
historical one.

Consequently "no outcome in this response" (§3.2a) means **the cited
historical occurrence has no `unitResult` in this response**, not that the
locator is absent from the quote.

This is deliberately not the alternative, source-exclusive model, in which
`PRIOR_FINAL_TRANSITION` would be permitted only for locators absent from
the quote. That model is coherent, but it would forbid reasserting a
repeatable transition and would require this specification to declare
transitions non-repeatable per unit, which no binding evidence supports.

The cost is explicit: a non-conformant producer may relabel a
current-request satisfier as prior final history, and core will accept it.
Core cannot detect this, because it holds the quote but not the unit's
history, and because a producer blocked from reusing one transition value
can simply cite another. Authenticating that a cited occurrence really
happened is therefore wholly a binding trace-conformance obligation, for
this and every other false-history claim.

`PRIOR_FINAL_TRANSITION` evidence MUST additionally satisfy `finalizedAt <=
evaluatedAt` on the report that cites it. Evidence cannot have become final
after the pass that reported it as already-final history. Equality is
permitted: a transition finalized at the evaluation instant is admissible
evidence. This is a consistency check over two timestamps already on the wire
and is in addition to, not a replacement for, `finalizedAt` format validation.

A missing coverage entry, an unknown relation, a duplicate reference, or a
coverage/failure contradiction is invalid. Early stopping MUST NOT masquerade
as PASSED or DEFERRED. If evaluation cannot be completed or justified by these
dependency rules, a provider MUST stop before dispatch and use its binding's
error mechanism; it MUST NOT invent a known admission failure. In particular,
absence of an evaluator is not an UNAVAILABLE repair witness.

`coverage` and `failures` are correlated by relation identity; `dependsOn`
is a set of relation identities, `satisfactions` a set of participants,
`requiredParticipants` a set of required participants, and a witness's
`requiredTransitions` a set of units that must be added to repair the
relation — it names what is missing, never an order in which to add it.
Their array order carries no semantic meaning. Providers SHOULD use
stable ordering for reproducible diagnostics, while callers and validators
MUST NOT infer evaluation order, dependency priority, or result meaning from
array position.

Coverage is a promise about this request's **one evaluation pass at the
evaluated binding state**, not about future requests or a locked snapshot.
Bindings MUST document the state/read consistency of that pass and the real
inputs preventing deferred evaluation. Core/schema checks can validate shape
and correspondence, but only binding evidence can establish that PASSED,
FAILED, or DEFERRED is truthful. JSON Schema alone cannot cross-check arbitrary
relation IDs against a quote or correlate the two arrays; runtime validation
and provider-side trace conformance are also required.

Before dispatch, the reference provider requires hook coverage even if no
failures were returned; all entries must then be PASSED. It preserves the
validated report and attaches it beside, never inside, `CommitResult` on the
successful path. An unknown quote cannot provide quote/proposal correlation
and therefore fails rather than fabricating a report.

Only a transition known final may support `PRIOR_FINAL_TRANSITION` evidence.
Submitted, pending, provisional, and failed transitions MUST NOT qualify. If a
terminal transition becomes visible only after finalization, a stale read can
show older state and cause rejection, which fails closed. A state source that
reports completion before finality can instead produce an unsafe pass. This
evidence narrows the snapshot problem for monotonic terminal transitions; it
does not solve general distributed-state or check-to-dispatch consistency.
Each binding MUST document its read consistency and finality rules.
Provider/binding trace conformance, not the domain-blind core, MUST substantiate
that opaque history is truthful and semantically sufficient.

An aggregate set of COMPLETE witnesses permits a union amendment only if the
binding can reconcile and authorize those transitions. It does not promise
that the next proposal will pass, bound remaining repair round trips under
state changes or newly activated dependencies, or guarantee atomic commit.

Every failed relation MUST identify a relation declared by the quote and
carry exactly one explicit witness disposition:

- `COMPLETE` MUST include a non-empty `requiredTransitions` list that is
  sufficient to construct an amendment for **that relation at that
  evaluated state**. The list is a set: its order is not semantic, and a
  conformance comparison MUST NOT treat a permutation of it as a different
  witness;
- `PARTIAL` MUST include a non-empty informative list, but the provider
  MUST NOT advertise it as sufficient for local repair;
- `UNAVAILABLE` carries no transition list because the provider cannot
  supply trustworthy repair information;
- `NOT_REPAIRABLE` carries no transition list because adding transitions
  cannot repair this failure.

Every `RequiredTransition` names a binding-scoped `unitLocator` whose
`scopeRef` MUST match the failed relation, plus the opaque required
`transition`. Duplicate locators, contradictory transitions for one
locator, quote-present locators advertised as missing, unknown relations,
and wrong-scope references are non-conforming. Whether an otherwise
well-shaped locator resolves to a real domain unit is a binding validation
obligation. Because domain state and transitions are opaque to the core,
schema and core validation cannot prove that a non-empty `COMPLETE` list is
semantically complete. That is a provider/binding conformance promise and
MUST be tested against the binding's declared relation semantics.

A caller using a `COMPLETE` witness MUST construct a new
`MutationProposal` and obtain a new `MutationQuote`. It MUST NOT append an
unquoted unit to the old `CommitRequest`. The new quote may assign entirely
new quote-local `unitRef`s; the binding maps the same domain units through
`unitLocator`. The amended proposal and quote remain independently subject
to authorization, expiry, snapshots, acceptance constraints, idempotency,
and a fresh admission evaluation. A witness conveys required information,
not permission. Bindings MUST apply their existing authorization policy to
every added transition and their existing idempotency rules to changed
request content; MSE does not define either protocol.

The reference provider invokes a synchronous binding evaluator immediately
before its in-process dispatch loop and performs no asynchronous yield
between them. That demonstrates a check-before-dispatch boundary and an
observable zero-dispatch refusal, not a distributed lock. An external-state
binding MUST document whether it validates and dispatches atomically or
revalidates within its own transaction. If state can change after the last
check and dispatch may have occurred, a clean admission refusal is no
longer available; normal per-unit determinacy and reconciliation apply.

On the `COMMIT_RESULT` branch, a provider processing a `CommitRequest`
MUST produce a `CommitResult`
whose `unitResults` gives **exactly one** of the following three outcomes
**for each unit** (see §1b for the coverage requirement this implies):

- **`APPLIED`** — this unit's mutation was applied. `committedEffects`
  MUST be present and MUST NOT differ from this unit's quoted effects for
  any effect whose `guarantee.mode` was `EXACT`. `refusalReason` and
  `reconciliation` MUST be absent. (See §4.)
- **`REFUSED`** — this unit's mutation was not applied. `refusalReason`
  MUST be present. `committedEffects` and `reconciliation` MUST be absent.
- **`INDETERMINATE`** — the provider cannot safely tell the caller whether
  this unit's mutation applied (e.g. a network timeout after the request
  reached the backend). `committedEffects` MUST be absent — a provider
  MUST NOT claim effects it does not know occurred. `refusalReason` MUST
  also be absent; `reconciliation` MUST be present (see §4b). A caller
  receiving `INDETERMINATE` for a unit MUST
  NOT retry that unit's commit as if it were a clean `REFUSED`, because a
  naive retry may cause a duplicate mutation for that unit specifically —
  other units in the same `CommitResult` are unaffected and MAY already be
  `APPLIED`.

One unit's outcome MUST NOT be inferred from another's. A provider
returning `APPLIED` for `unit_a` and `INDETERMINATE` for `unit_b` in the
same `CommitResult` has produced a perfectly ordinary result, not an edge
case requiring special handling.

### 3.2a Admission-time satisfaction vs. execution-time realization

A `CURRENT_REQUEST` satisfaction record establishes exactly one thing: the
required transition **was present in the evaluated proposal when admission
ran**. It MUST NOT be read as proof that the satisfaction took effect.

At admission a current-request satisfier has only been *requested*, which is
the same not-yet-final condition the `PRIOR_FINAL_TRANSITION` branch excludes
for prior history. Because acceptance constraints come from the caller, a
caller can deliberately produce a response in which admission passed on a
cited transition that the same response then refuses: the request redeems two
units, a constraint refuses one of them, and the other is `APPLIED`. The
`PASSED` record is truthful about admission and contradicted by execution.

Admission-time `PASSED` is therefore **not** rewritten, downgraded, or
recomputed by execution. The two questions stay separate:

- admission answers *was the required transition present when the gate ran*;
- realization answers *did that satisfaction take effect*, which only a
  `COMMIT_RESULT` can answer.

When a `COMMIT_RESULT` is available, validation MUST correlate every
`CURRENT_REQUEST` satisfaction record with the `unitResult` of the unit it
cites. The correlation is total and deterministic:

| Satisfaction source | Correlated `unitResult.outcome` | Realization |
| --- | --- | --- |
| `CURRENT_REQUEST` | `APPLIED` | `REALIZED` |
| `CURRENT_REQUEST` | `REFUSED` | `NOT_REALIZED` |
| `CURRENT_REQUEST` | `INDETERMINATE` | `INDETERMINATE` |
| `PRIOR_FINAL_TRANSITION` | none in this response | `REALIZED` |

A `PRIOR_FINAL_TRANSITION` record is `REALIZED` and carries no correlated
outcome, **conditional on a binding-owned claim core does not verify**. The
division is:

- core validates the record STRUCTURALLY: source shape, participant scope,
  the transition's correspondence to the asserted required participant,
  `finalizedAt` format, and `finalizedAt <= evaluatedAt`;
- the binding authenticates it SEMANTICALLY: that the cited `transitionRef`
  resolves to a real historical occurrence with that transition and
  finalization instant, and that the occurrence satisfies the relation.

Given a conformant binding, the satisfaction occurred historically rather
than in this request, which is why it realizes; the record's `source`
carries that distinction. Core accepting a prior-final record is NOT by
itself evidence that the cited history happened. Reporting it as inapplicable would withhold a
verdict in the case where the evidence is strongest, and would collide with
the separate `NOT_APPLICABLE` admission coverage status this revision
deliberately did not add.

A `CURRENT_REQUEST` record whose cited `unitRef` has no `unitResult` in the
correlated `CommitResult` is invalid: realization cannot be determined, and
§1b already requires complete per-unit coverage.

#### The consumer rule (normative)

Discovering the contradiction during validation is not sufficient. The
semantic hole is that a reader can see `PASSED` and infer that the
satisfaction took effect. The obligation therefore binds consumers, not only
validators:

> Once a `COMMIT_RESULT` exists for a quote, a consumer **MUST NOT** interpret
> `CURRENT_REQUEST` satisfaction evidence in an admission-time `PASSED` entry
> as realized satisfaction without correlating that evidence to the
> `unitResults` of the same response. The correlated outcome is decisive:
> `APPLIED` means realized, `REFUSED` means **not** realized, and
> `INDETERMINATE` means realization is unknown and MUST NOT be assumed in
> either direction.

A consumer that reads `PASSED` alone and concludes the gated transition
occurred is **non-conformant**, even though the `PASSED` entry itself is
truthful. Concretely, a consumer MUST NOT, on the basis of an admission
`PASSED` alone:

- report or display the gated transition as having occurred;
- treat a coupled fee, entitlement, or obligation the gate exists to capture
  as captured;
- suppress reconciliation for an `INDETERMINATE` satisfier; or
- skip its own correlation because a producer, intermediary, or validator is
  presumed to have performed it.

Where a consumer cannot perform the correlation itself — for example a reader
handed `coverage` without the sibling `CommitResult` — it MUST treat
`CURRENT_REQUEST` evidence as admission-time only and MUST NOT upgrade it to
realized satisfaction. Absence of the correlated result is not permission to
assume the favorable reading; this is the same fail-closed posture §3.2
applies to constraint evaluation.

This rule is what keeps realization derived rather than duplicated onto the
wire. The producer is not required to compute or carry a verdict the consumer
is obliged to derive from facts it already holds.

To keep the obligation from resting on an optional call, the correlation
SHOULD be part of an implementation's standard `COMMIT_RESULT` validation
path rather than a separate utility a consumer may never invoke. The
reference implementation does this in two places: validating a response with
`assertCommitResponseWellFormed` **returns** the realization report, and
`ReferenceProvider.satisfactionRealization(quoteId)` answers the same
question after commit. Both return nothing when no execution outcome is
available, which is the fail-closed case above and never permission to assume
the favorable reading.

A derived aggregate over these entries MUST be non-vacuous: "all realized"
holds only when there is at least one entry **and** every entry is
`REALIZED`. An empty entry set MUST NOT report as fully realized, because a
response that evidenced nothing has realized nothing; reporting otherwise
would invert the fail-closed reading this section requires.

The scope of that aggregate is **the satisfaction records present in the
report**, not the set of admission relations. A relation that passed without
supplying satisfaction evidence contributes no realization entry and is
therefore neither counted nor vouched for. A report carrying one
evidence-bearing realized relation alongside one evidence-free passed
relation aggregates to "all realized", and that verdict says nothing
whatever about the second relation. A consumer MUST NOT read the aggregate
as proof that every gate was realized, and MUST inspect `coverage` to learn
which relations supplied evidence at all.

Nor is the aggregate a statement about commit success. A request admitted
entirely on prior final history, whose quote then expires before dispatch,
yields `ALL_REFUSED` per-unit outcomes and a fully realized satisfaction
aggregate in the same response. Both are correct: nothing committed, and
the cited historical satisfaction still occurred. A consumer asking whether
the mutation succeeded MUST read `unitResults` (§1b, §1c), never this
aggregate.

`NOT_REALIZED` and `INDETERMINATE` are **not** response-level errors. They are
the ordinary consequence of non-atomic execution (§1d) and MUST NOT cause a
conformant response to be rejected. What they forbid is a reader taking the
pass at face value.

A realization entry is not self-describing. It carries the relation, the
source, and the participant, but not the satisfaction's transition, so it
identifies its satisfaction only together with the `AdmissionReport` it was
derived from. Within one report the tuple (`relationId`, `source`,
participant) is unique, because a relation MUST NOT repeat satisfaction for
one binding-scoped unit, so a prior transition A and a different current
transition B on the same unit remain distinguishable when correlated
properly. Consumers MUST join on that tuple rather than assume an entry
stands alone.

Like `aggregateHint` (§1c), this correlation is **non-authoritative and purely
derived**: it is computed from `coverage[].satisfactions` and
`commitResult.unitResults`, both already on the wire, and adds no field to the
admission entry. The reference implementation exposes it as a checkable pair —
`deriveSatisfactionRealization` and `assertSatisfactionRealizationConsistent`
in [`/src/core/validate.ts`](../src/core/validate.ts). A caller MUST NOT read
a realization verdict as an admission result or an admission result as a
realization verdict.

This does **not** make `REQUIRES_COINCLUSION` atomic or ordered. A binding is
**not** required to dispatch a dependent unit only after its satisfiers are
`APPLIED`, and a dependent whose satisfier ends `REFUSED` or `INDETERMINATE`
is **not** thereby refused. Ordered dispatch remains one legitimate binding
strategy a binding MAY adopt for a directional gate, outside this relation and
outside the core; §1d is unchanged. Making the contradiction visible is a
reporting obligation, not an execution guarantee.

---

### 3.3 CommitResult → Receipt

A `Receipt` MUST report a `finality` for every committed effect (i.e.
every effect present in some unit's `committedEffects`), using
`EffectFinality`, per the fail-clear coverage rule in §6a:

- **`FINAL`** — this effect's realized value will not change further.
- **`PENDING`** — this effect is still in flight (e.g. a refund queued but
  not yet settled).
- **`FAILED`** — this effect was expected to complete but did not, and will
  not be retried automatically by the provider merely because a `Receipt`
  was requested.
- **`UNKNOWN`** — the provider cannot currently determine this effect's
  state.

A unit's `APPLIED` outcome together with one or more of its
`effectReceipts` entries showing `PENDING` or `FAILED` is a valid and
expected receipt shape. A provider MUST NOT infer or imply overall failure
of a unit's mutation from a non-`FINAL` downstream effect, and MUST NOT
imply overall success of every downstream effect merely from that unit's
`APPLIED` outcome.

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
to which `effectId`/`type` uses which variant.

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
  "effectId": "abc123:seg_2:fare_delta",
  "operator": "<=",
  "value": { "type": "money", "amount": "150.00", "currency": "USD" }
}
```

against an effect shaped as
`{ "effectId": "abc123:seg_2:fare_delta", "type": "travel:fare_delta", "value": { "type": "money", "amount": "84.00", "currency": "USD" }, ... }`
— see
[`/examples/travel/acceptance-constraint.fixture.json`](../examples/travel/acceptance-constraint.fixture.json).

---

## 4b. The INDETERMINATE resolution contract

External review established a second falsification: v0.1.0 told a caller
*not to retry blindly* on `INDETERMINATE` but did not normatively expose
*how* the caller could resolve the uncertainty — the reference
implementation happened to have a reconciliation helper, but nothing in
the schema represented it. v0.2.0 fixes this by requiring every
`INDETERMINATE` `UnitResult` to carry a `Reconciliation` object.

`Reconciliation.mode` MUST be one of:

- **`MACHINE_RESOLVABLE`** — a binding/profile-defined operation exists
  that a caller (or its agent) can invoke programmatically to learn the
  unit's actual outcome.
- **`AUTHORITATIVE_READ`** — no dedicated reconciliation operation exists,
  but a binding can define an authoritative read/status path (e.g.
  re-fetching the target resource, or a specific field on it) whose result
  resolves the unit's true outcome.
- **`NONE`** — no machine-resolvable path is available at all. The caller
  has no programmatic way to resolve the uncertainty through MSE and MUST
  fall back to non-MSE means (manual investigation, support escalation,
  etc.).

A provider **MUST NOT** report `MACHINE_RESOLVABLE` or `AUTHORITATIVE_READ`
unless a real path actually exists and is actually reachable by the
caller. Pretending an unavailable recovery path is actionable is a
conformance violation, not an optimistic default — representing the
absence of a path honestly (`NONE`) is strictly preferable to overstating
one that doesn't work.

When `mode` is `MACHINE_RESOLVABLE` or `AUTHORITATIVE_READ`,
`Reconciliation.correlationId` **MUST** be present — it correlates a
future reconciliation/read attempt back to this specific indeterminate
attempt (and, transitively, to the `unitRef` it resolves, since a
provider's reconciliation lookup MUST map a `correlationId` back to
exactly one unit). When `mode` is `NONE`, `correlationId` **MUST** be
absent, since there is nothing to correlate a nonexistent path against.
`Reconciliation.reference` is an optional, opaque, binding-defined pointer
(an operation name, a resource locator, a polling descriptor) describing
how to actually invoke the path; the core does not interpret it.

**A binding or profile that exposes `MACHINE_RESOLVABLE` or
`AUTHORITATIVE_READ` MUST define, in its own documentation (not in the
core schema):**

1. how the reconciliation/read operation is actually invoked (the
   transport call, endpoint, or method a caller uses);
2. how the original mutation attempt is correlated to that invocation
   (i.e. what `correlationId` and/or `reference` actually mean for that
   binding, and how a caller supplies them back);
3. how the reconciliation/read result maps back to the same `unitRef` it
   originated from, unambiguously;
4. that the reconciliation/read operation **observes or resolves the
   prior attempt** rather than **blindly replaying the mutation** — see
   §4c, which is the substantive requirement this documentation
   obligation exists to enforce.

A binding that cannot honestly satisfy all four MUST report `NONE` for
that path rather than claim a mode it cannot back up.

---

## 4c. Reconciliation is a read, never a replay

The single most important normative property of §4b's contract is this:
**reconciling an `INDETERMINATE` unit MUST be a status-resolution
operation over the prior attempt, not a new mutation attempt.**

Concretely: a conformant reconciliation/authoritative-read implementation
MUST determine what actually happened to the original commit attempt (by
consulting a ledger, querying the downstream system by the same
correlation reference it used internally, re-fetching authoritative state,
etc.) — it MUST NOT resubmit the unit's proposed change as if it were a
fresh commit. Resubmission is exactly the "blind retry" hazard
`INDETERMINATE` exists to prevent; a reconciliation path that is secretly
a retry has not solved the falsified problem, it has hidden it behind a
different name.

The reference implementation demonstrates this concretely:
`ReferenceProvider.reconcile(correlationId)` in
[`/src/core/reference-provider.ts`](../src/core/reference-provider.ts)
looks up the pending indeterminate unit by `correlationId` and asks the
injected `FaultInjector.reconciliationOutcome` hook what actually happened
— it does not call `commit()` again, and does not re-run the unit's
effect-generation logic to produce a "new" attempt. `reconciliationOutcome`
is deliberately not hardcoded to always return `"APPLIED"`: a test suite
using it demonstrates all three real possibilities (resolves to `APPLIED`,
resolves to `REFUSED`, or remains `undefined`/unresolved), because a
reconciliation path that could only ever discover success would
misrepresent what reconciliation actually is and would mask exactly the
failure mode (a mutation that silently never applied) that a real
authoritative check needs to be able to reveal.

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
might be).

`RefusalReason` is unchanged in shape by v0.2.0, but is now scoped per
unit (`UnitResult.refusalReason`) rather than to the whole mutation
attempt — see §1a-§1c.

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
storage and concurrency model. **This remains a real integration hazard
for adopters** (see
[`/docs/security-considerations.md`](../docs/security-considerations.md)
§4): a provider whose own adapter documentation fails to actually cover
every write path has a false-confidence gap that no schema check can
catch. `commitConsistency` currently applies at the whole-quote level, not
per-unit — see §8's open-issues list for the unresolved question of
whether a future revision should allow per-unit snapshot/drift
declarations.

---

## 6a. Receipt coverage and the commit-determinacy / effect-finality boundary

Two things that must not be merged, even though both now live at
finer-than-mutation-wide granularity in v0.2.0:

- **Commit-unit determinacy** — `UnitResult.outcome` (`APPLIED` /
  `REFUSED` / `INDETERMINATE`) — describes whether a specific unit's
  mutation attempt itself succeeded.
- **Effect finality** — `EffectReceipt.finality` (`FINAL` / `PENDING` /
  `FAILED` / `UNKNOWN`) — describes whether a specific *already-committed*
  effect's downstream consequences have settled.

An `APPLIED` unit MAY still have downstream effects that are `PENDING`,
`FAILED`, `UNKNOWN`, or `FINAL` — this was already true in v0.1.0 and
remains true per-unit in v0.2.0. A `REFUSED` unit has **no** committed
downstream effects from that attempted unit to report finality on at all
— it contributes zero entries to `Receipt.effectReceipts`. An
`INDETERMINATE` unit **MUST NOT** claim `committedEffects` (§3.2), and
therefore likewise contributes no entries to `effectReceipts` until and
unless reconciliation (§4b-§4c) resolves it to `APPLIED`.

`Receipt` no longer carries a `mutationOutcome` field (removed in v0.2.0
— see §9): commit-unit determinacy is now fully and only carried by the
corresponding `CommitResult.unitResults`, and a `Receipt` MUST NOT
re-introduce any mutation-wide or unit-wide outcome summary of its own —
doing so would recreate exactly the information-collapsing problem §1c
addresses for `CommitResult`.

**Coverage rule (fail-clear, carried over from v0.1.0's §7, now scoped
across units):** `Receipt.effectReceipts` MUST contain exactly one
`EffectReceipt` for every effect present in *every* unit's
`committedEffects` across the whole `CommitResult` — an effect MUST NOT
silently disappear from the receipt. An effect that is not independently
trackable MUST still appear, with `finality: UNKNOWN`, rather than being
omitted. Omitting a committed effect from `effectReceipts` is a
conformance violation, not a valid partial receipt.

---

## 7. RefusalReason and Guarantee semantics recap

See §4 and §5 above; unchanged in substance by v0.2.0 beyond the per-unit
scoping already described.

---

## 7a. Effect identity: why `effectId` was added, and what remains ambiguous

v0.1.0 correlated an `Effect` across `MutationQuote` →  `CommitResult` →
`Receipt` primarily by `Effect.type`. Once a single mutation attempt can
span multiple independently committing units (§1a), `type` alone is no
longer sufficient: two different units can legitimately produce effects
of the identical `type` (e.g. two order lines each producing a
`retail:order_total_delta`), and nothing about `type` distinguishes which
unit's effect a constraint, a commit result, or a receipt entry is
actually talking about.

v0.2.0 therefore adds `Effect.effectId`: an opaque, domain-blind
identifier, **unique within the quote it appears in, across all units**.
All quote/commit/receipt correlation (`AcceptanceConstraint.effectId`,
the correlation inside `assertExactGuaranteesHonored`,
`EffectReceipt.effectId`) now runs over `effectId`, not `type`. `type`
remains present and namespaced exactly as before, but is no longer assumed
unique and MUST NOT be used for correlation.

A provider MUST assign `effectId` at quote time and MUST NOT reuse an
`effectId` for a different effect within the same quote — see
[`assertQuoteUnitsWellFormed`](../src/core/validate.ts) for the mechanical
check.

**Documented ambiguity, not silently resolved:** it is conceivable for a
mutation to produce a *genuinely cross-unit or shared* effect — one that
does not belong to exactly one `CommittingUnit` but is a joint consequence
of several (for example, a single tax recalculation effect resulting from
edits to two different order lines at once). v0.2.0's model assumes every
`Effect` belongs to exactly one unit's `effects` array; it does not define
how to represent an effect that is honestly shared across units without
either (a) picking one unit arbitrarily to "own" it, which would
misrepresent causality, or (b) duplicating it into multiple units' effect
lists under different `effectId`s, which would misrepresent it as two
separate effects when it is actually one. Neither option was adopted here
because doing so would require guessing at a shape without real-provider
input on which of these two failure modes is more costly in practice. This
is left as an explicit open question — see §8 — rather than resolved by
assumption.

---

## 7b. The full correlation chain: ownership, not just existence

Adding `effectId` (§7a) makes an effect globally identifiable, but a
correlation check that only confirms an `effectId` *exists somewhere* is
not sufficient. The complete chain a conformant implementation MUST
enforce is:

```text
quote unit  →  committed unit result  →  committed effect  →  effect receipt
(unitRef)      (UnitResult.unitRef)       (Effect.effectId)     (EffectReceipt.effectId + unitRef)
```

`effectId` identifies *which effect*; `unitRef` identifies *which
independently committing unit that effect belongs to*. Both MUST agree at
every step of the chain above — an `effectId` existing correctly somewhere
in a quote or commit result does not, by itself, establish that it is
attributed to the *correct* unit at every later step.

**Committed-effect ownership (`CommitResult.unitResults[].committedEffects`):**
For every effect a `UnitResult` claims to have committed, that effect's
`effectId` MUST have been quoted specifically under the `CommittingUnit`
whose `unitRef` matches that `UnitResult.unitRef`. Concretely:

- an `effectId` that was quoted under a different unit MUST NOT be
  accepted as committed by this unit — misattributing an effect from one
  unit to another (even if the `effectId` is otherwise valid and
  unaltered) is a conformance violation, not a cosmetic mismatch;
- an `effectId` that was never quoted at all MUST NOT be accepted as
  committed by any unit;
- a given `effectId` MUST NOT be claimed as committed by more than one
  `UnitResult` in the same `CommitResult`.

This is a **separate normative invariant** from the EXACT-guarantee check
in §3.1/§4: a provider could satisfy "this effect's value did not drift
between quote and commit" while still misattributing which unit actually
produced it (e.g. by attaching a quoted effect from unit A into unit B's
`committedEffects` unchanged). EXACT-guarantee honoring alone does not
catch this, because it only looks up an `effectId` within whichever unit
already claims it — it does not check whether that unit was the one that
actually quoted it. An implementation MUST check ownership independently
(see `assertCommittedEffectsBelongToUnits` in
[`/src/core/validate.ts`](../src/core/validate.ts)), not rely on
EXACT-guarantee validation to incidentally catch it.

**Receipt ownership (`Receipt.effectReceipts`):** For every
`EffectReceipt`, both of the following MUST hold, not merely that
`effectId` is present somewhere among committed effects:

- `EffectReceipt.effectId` MUST correspond to an effect that some
  `UnitResult` in the corresponding `CommitResult` actually committed — a
  receipt referencing an `effectId` that was never committed (whether
  because it was never quoted at all, or was only quoted/refused and
  never applied) is non-conforming; **receipts MUST NOT invent effects
  that were not committed**;
- `EffectReceipt.unitRef` MUST equal the `unitRef` of the `UnitResult`
  that actually committed that effect. **A receipt that names the correct
  `effectId` but the wrong `unitRef` is non-conforming**, even though the
  `effectId` itself is globally valid and genuinely was committed — e.g.
  `effect-1` was quoted and committed under `unit-A`, and a receipt entry
  reporting `{effectId: "effect-1", unitRef: "unit-B"}` MUST be rejected,
  because it misattributes a real, correctly-committed effect to the
  wrong unit.

**Duplicate receipts:** unless a future revision explicitly defines a
different multiplicity model, `Receipt.effectReceipts` MUST NOT contain
more than one entry for the same `effectId`. A duplicate is non-conforming
regardless of whether the duplicate entries agree with each other.

After the above per-entry checks, the fail-clear coverage rule from §6a
still applies in full: every committed effect (across every unit) MUST
have exactly one corresponding receipt entry, with `finality: UNKNOWN` for
an untrackable one rather than omission.

---

## 8. Open issues (non-normative until resolved)

1. **Multiple outstanding quotes against the same target.** Carried over
   from v0.1.0, still open. §6's resolution (snapshot is provider-defined,
   adapters document their own drift detection) narrows this somewhat but
   does not mandate a concurrent-quote policy.
2. **Whether `commitConsistency`/`snapshot` should be expressible per-unit
   rather than only per-quote.** Added in v0.2.0's review. Now that a
   quote can carry multiple independently committing units, it is not
   obvious that all units of a quote should necessarily share one
   consistency policy — a provider might reasonably want
   `SNAPSHOT_REQUIRED` drift detection on one unit and `NONE` on another
   within the same quote. v0.2.0 keeps `commitConsistency` at the
   whole-quote level rather than guessing at a per-unit shape without
   real-provider motivation for one.
3. **Cross-unit/shared effects.** See §7a's documented ambiguity: v0.2.0's
   model has no representation for an effect that is a genuine joint
   consequence of more than one unit, as opposed to belonging to exactly
   one. Left open pending real-provider examples of this actually
   occurring, rather than guessed at. Admission relations can represent a
   separate delivery unit that gates goods transitions; they do not solve
   ownership of a genuinely joint tax/shared effect.
4. **Whether `AggregateHint` should be richer than four values.** v0.2.0
   keeps it minimal (`ALL_APPLIED` / `ALL_REFUSED` / `ALL_INDETERMINATE` /
   `MIXED`) specifically because it is explicitly non-authoritative
   convenience, not load-bearing — but a reviewer may reasonably ask
   whether a finer-grained (but still non-authoritative) summary would be
   more useful without encouraging misuse as an authoritative field. Not
   pursued in this revision to avoid growing a field whose entire point is
   to stay minimal and clearly secondary to `unitResults`.
5. **Whether one directional co-inclusion relation is sufficient.**
   v0.3.0 intentionally avoids a generic constraint/workflow language.
   More relation types require concrete provider evidence before entering
   the core.
6. **How external-state bindings close the admission-to-dispatch gap.**
   The reference provider is synchronous and in-process; it does not prove
   that a distributed provider can offer the same boundary without a
   binding-specific transaction or final revalidation mechanism.
7. **Whether execution-time realization should be carried on the wire or
   derived by validation.** §3.2a derives it, because both inputs
   (`coverage[].satisfactions` and `commitResult.unitResults`) are already in
   the response and a derived verdict cannot drift from them. The cost is that
   a reader who inspects only `coverage` still sees an unqualified `PASSED`
   and must run the correlation (or trust a party who did) to learn that a
   satisfier was refused. A wire-visible per-record verdict would make the
   contradiction legible without computation, at the price of a redundant,
   forgeable field that can contradict the `unitResults` beside it, and of
   admission data that is only completable after execution. A third option —
   an `AdmissionReport`-level flag asserting that every current-request
   satisfier was applied — is smaller but collapses the per-record detail
   that the mixed cancel case needs. This revision takes the derived option
   and leaves the wire-visible variant open pending a reader that cannot run
   the correlation itself.

---

## 9. Compatibility with v0.2.0 (breaking changes)

v0.3.0 is a **breaking revision**, not a patch. Compatibility differs by
surface:

| Surface | v0.2.0 | v0.3.0 impact |
|---|---|---|
| Quote wire schema | `CommittingUnit` had `unitRef` + `effects`; no `admissionRelations` | Every unit additionally requires `unitLocator` + `transition`; every quote requires `admissionRelations` (possibly empty). Old closed-schema consumers reject these fields, and old producers omit required fields. |
| Commit wire/API | `commit()` returned `CommitResult` directly | `commit()` returns discriminated `CommitResponse`; callers must branch before reading `commitResult`. |
| TypeScript callers | Direct access to `response.unitResults` | Narrow `response.kind === "COMMIT_RESULT"`, then access `response.commitResult.unitResults`; handle `ADMISSION_REFUSED`. |
| Existing providers | No proposal retention or admission hook | Populate new quote fields, retain/map submitted transitions, and evaluate declared relations; the v0.3.0 reference provider failed closed with `UNAVAILABLE` when a relation existed without an evaluator (superseded by §9a). |
| Per-unit result/reconciliation/receipt | v0.2.0 outcomes and semantics; schema/types accidentally allowed `APPLIED` without `committedEffects` despite normative prose | Preserved inside `COMMIT_RESULT`; schema/types now enforce the existing requirement that `APPLIED` carries `committedEffects` (even when empty) and that outcome-specific fields are exclusive. |

There is no legal in-place amendment of a v0.2.0/v0.3.0 quote. A repaired
proposal receives a new quote. Supporting both versions requires separate
schema identifiers and explicit API version dispatch; implementations MUST
NOT silently reinterpret one version as the other.

### Historical v0.2.0 compatibility with v0.1.0

v0.2.0 is a **breaking revision**. The following v0.1.0 shapes no longer
exist and MUST NOT be produced or expected by a v0.2.0-conformant
implementation:

| Removed / changed in v0.2.0 | v0.1.0 shape | v0.2.0 replacement |
|---|---|---|
| `MutationQuote.effects` (top-level) | `Effect[]` | `MutationQuote.units: CommittingUnit[]`, each carrying its own `effects` |
| `CommitResult.outcome` | mutation-wide `CommitOutcome` | `CommitResult.unitResults[].outcome` (`UnitOutcome`, per unit) |
| `CommitResult.refusalReason` | mutation-wide | `CommitResult.unitResults[].refusalReason`, per unit |
| `CommitResult.committedEffects` | mutation-wide `Effect[]` | `CommitResult.unitResults[].committedEffects`, per unit |
| `Receipt.mutationOutcome` | mutation-wide `CommitOutcome` | removed entirely — see §6a; use the corresponding `CommitResult.unitResults` |
| `AcceptanceConstraint.effectType` | correlated by `Effect.type` | `AcceptanceConstraint.effectId`, correlated by `Effect.effectId` (§7a) |
| `EffectReceipt.effectType` | correlated by `Effect.type` | `EffectReceipt.effectId` + `EffectReceipt.unitRef` (§7a) |
| *(new, no v0.1.0 equivalent)* | — | `Effect.effectId` (required); `CommittingUnit`/`unitRef`; `CommitResult.aggregateHint` (optional); `UnitResult.reconciliation` / `Reconciliation` (§4b-§4c) |

There is no automatic migration: a v0.1.0 message is not a valid v0.2.0
message and vice versa. An implementation supporting both versions MUST
treat them as distinct schemas (the historical v0.2.0 schema used the
`https://mutation-safety-envelope.org/schema/v0.2.0/...` identifier) and
MUST NOT attempt to silently interpret one as the other.

This is a deliberate, falsification-driven break, not scope creep: no
domain vocabulary (SKUs, fares, plans, refund rules, etc.) was added to
the core in this revision, and MSE's transport-neutral,
identity-agnostic, and domain-blind boundaries (§1) are unchanged. See
[`/docs/v0.2-review-response.md`](../docs/v0.2-review-response.md) for the
full account of what was falsified, what changed, and what remains
unresolved.


## 9a. v0.3.0 → v0.4.0-dev.0 compatibility

Required report coverage, `AdmissionSatisfaction`, `AdmissionRelation.passEvidence`,
and the public `AdmissionCoverage` union change the closed schema and TypeScript
API. `COMMIT_RESULT` now requires a sibling `admissionReport`; admission data is
not merged into `CommitResult`. `AdmissionEvaluation` hooks must return coverage
on both failed and successful evaluations. Missing hooks now
raise a pre-dispatch error instead of fabricating UNAVAILABLE failure witnesses.
These breaks warrant a new minor revision under this pre-1.0 project's convention.

`AdmissionCoverage` PASSED entries gain `requiredParticipants`. The JSON
Schema change is additive — one new optional property and its definition, with
no path removed and no existing value altered — but **the validation contract
is strictly stricter, which is a breaking semantic change**. Payloads that
validated under the earlier `0.4.0-dev.0` state can now fail:

- a `PASSED` entry for a relation declaring `passEvidence: REQUIRED` that
  omits `requiredParticipants` is now invalid;
- evidence citing the right unit with a different transition than that
  participant was required to contribute is now invalid;
- prior-final evidence whose `finalizedAt` is after the report's
  `evaluatedAt` is now invalid (unchanged from the previous revision);
- satisfaction evidence that does not cover the stated set exactly is now
  invalid; and
- `PRIOR_FINAL_TRANSITION` evidence with `finalizedAt` after the report's
  `evaluatedAt` is now invalid, where previously only its format was checked.

Producers must emit the participant set; consumers additionally acquire the
§3.2a correlation obligation. Because this is unreleased development work, the
strengthening lands in `0.4.0-dev.0` rather than requiring a further revision;
published v0.3.0 artifacts are unaffected.

Execution-time realization of `CURRENT_REQUEST` evidence is derived by
validation from data already on the wire (§3.2a). That part adds no wire
field, no lifecycle state, and no ordering requirement, but it does add a
normative consumer rule.

Migrate evaluators to record actual evaluation results for every declaration,
report all independently evaluable failures, and identify genuine repair
dependencies. Do not populate PASSED solely because a relation is absent from
an untrusted/incomplete failure list. When a binding declares pass evidence
required, report current-request or cited prior-final satisfaction and enforce
its truth through binding trace conformance. Existing witnesses, quote fields,
per-unit outcomes, reconciliation, and receipts retain their meanings.
This is unreleased development work; published v0.3.0 artifacts are unchanged.
