# Conformance

**Status:** v0.4.0-dev.0, unreleased development revision.

> Conformance here means conformance with **this repository's own** schema
> and normative spec. It is not, and does not imply, conformance with any
> vendor or standards-body specification. See
> [`/docs/DISCLAIMER.md`](./DISCLAIMER.md).
>
> Nothing in this repository's test suite is, or should be described as,
> an official UCP conformance test. See `/ucp-binding` for the (sketch,
> non-normative) relationship to UCP.

## What "conformant" means for a provider

A provider claiming MSE v0.4.0-dev.0 conformance MUST:

1. Produce `MutationQuote` documents that validate against
   [`/schema/mse-core.schema.json`](../schema/mse-core.schema.json),
   including a well-formed `units` array (unique quote-local `unitRef`s,
   unique binding-scoped `unitLocator`s, explicit opaque `transition`s,
   unique `effectId`s across all units) and an `admissionRelations` array,
   even when empty (spec §1a, §1d, §7a).
2. Treat producing a quote as non-mutating: it MUST NOT commit the
   requested commercial mutation itself. A disclosed, reversible
   reservation/hold (surfaced as an `Effect`) is the one permitted
   exception (see spec §3.1 and `/docs/ambiguities.md` §4).
3. Never mark an `Effect.guarantee.mode` as `EXACT` unless prepared to
   honor it per spec §3.1 and §4.
4. Evaluate every `AcceptanceConstraint` fail-closed per spec §3.2 before
   returning `APPLIED` for the unit(s) it names, correlating by
   `effectId` (not `type`) across all units in the quote (spec §7a).
5. Evaluate every independently evaluable applicable quote-declared admission relation against
   current binding state before dispatch. A known `ADMISSION_REFUSED`
   MUST mean zero commercial mutations were dispatched. Every failure
   MUST name a declared relation and carry an honest `COMPLETE`, `PARTIAL`,
   `UNAVAILABLE`, or `NOT_REPAIRABLE` witness per spec §3.2. A complete
   witness is sufficient only for its relation and MUST NOT authorize
   added transitions or bypass a new quote. Admission evaluation itself
   MUST be observational and MUST NOT dispatch a quoted transition.
   Refusals MUST cover every declaration with PASSED, FAILED, or genuinely
   repair-dependent DEFERRED (spec §3.2). Failures and FAILED coverage entries
   MUST correspond exactly. Provider-side traces must substantiate evaluation
   and deferral; schema validity alone does not prove exhaustive reporting.
   Early stop and missing evaluators MUST fail before dispatch, without
   inventing a failure witness.
6. Produce a `CommitResult.unitResults` entry for **every** unit in the
   quote — no silent omission, no duplicates, no unknown `unitRef` (spec
   §1b) — each giving exactly one of `APPLIED` / `REFUSED` /
   `INDETERMINATE` for that unit, with `refusalReason` present whenever
   that unit is `REFUSED`, `committedEffects` present whenever it is
   `APPLIED` (even when empty), and `reconciliation` present whenever that
   unit is `INDETERMINATE`; fields belonging to another outcome MUST be
   absent (spec §3.2, §4b).
7. Never silently alter an `EXACT`-guaranteed effect's value between quote
   and commit for any unit; doing so invalidates that unit's `APPLIED`
   result regardless of what outcome value the provider returns (see spec
   §3.1, and `assertExactGuaranteesHonored` in
   [`/src/core/validate.ts`](../src/core/validate.ts), which a reviewer can
   run against a provider's recorded quote/commit pairs to check this
   mechanically).
8. Never misattribute a committed effect to the wrong unit: every
   `effectId` a `UnitResult` claims to have committed MUST have been
   quoted specifically under that same `unitRef`, and MUST NOT be claimed
   by more than one `UnitResult` in the same `CommitResult` (spec §7b).
   This is checked separately from EXACT-guarantee honoring — see
   `assertCommittedEffectsBelongToUnits` in
   [`/src/core/validate.ts`](../src/core/validate.ts).
9. Ensure every `EffectReceipt` names both the correct `effectId` **and**
   the correct `unitRef` for the unit that actually committed it — a
   receipt naming a valid, actually-committed `effectId` under the wrong
   `unitRef` is non-conforming, not merely imprecise (spec §7b). Receipts
   MUST NOT invent effects that were not committed, and MUST NOT duplicate
   an entry for the same `effectId`. See the strengthened
   `assertReceiptCoversAllCommittedEffects` in
   [`/src/core/validate.ts`](../src/core/validate.ts), which checks the
   full correlation chain (quote unit → committed unit result → committed
   effect → effect receipt), not merely that an `effectId` appears
   somewhere.
10. Never claim `MACHINE_RESOLVABLE` or `AUTHORITATIVE_READ` reconciliation
   for an `INDETERMINATE` unit unless a real, working path exists, and
   never implement that path as a replay of the mutation rather than a
   read/status-resolution of the prior attempt (spec §4b-§4c).
11. Report `EffectFinality` for downstream effects using `Receipt`, and
    never conflate a `PENDING`/`FAILED`/`UNKNOWN` downstream effect with
    overall mutation failure, or vice versa, at the unit level (spec §3.3,
    §6a).
12. Never re-introduce a mutation-wide or cross-unit outcome summary on
    `Receipt` — commit-unit determinacy lives only in
    `CommitResult.unitResults` (spec §6a). If `CommitResult.aggregateHint`
    is present, it MUST be the single value the deterministic derivation
    rule in spec §1c produces from `unitResults` — a provider emitting a
    contradictory hint is non-conforming even though the field itself is
    optional and non-authoritative (see `assertAggregateHintConsistent` in
    [`/src/core/validate.ts`](../src/core/validate.ts)). A caller MUST
    still treat the field as non-authoritative regardless.

## What "conformant" does NOT require

A conformant provider is **not** required to:

- support every `GuaranteeMode` for every effect (a provider may choose to
  offer only `UNKNOWN` guarantees if that is honestly all it can offer —
  this is legal, if not very useful to callers);
- support `commitConsistency: SNAPSHOT_REQUIRED` (a provider may declare
  `NONE` if it offers no drift detection at all);
- implement every effect type used in this repository's domain examples —
  those are illustrative, not a required vocabulary;
- offer multi-unit quotes at all — a single-unit `MutationQuote.units`
  array is the fully valid degenerate case (spec §1a);
- declare an admission relation when no binding rule applies; the required
  `admissionRelations` array may be empty;
- offer `MACHINE_RESOLVABLE` or `AUTHORITATIVE_READ` reconciliation for
  every, or any, `INDETERMINATE` unit — honestly reporting
  `reconciliation.mode: NONE` is a legal, conformant answer when no real
  path exists (spec §4b).

## Self-check tooling in this repository

- `node scripts/reproduce-v0.3.mjs` extracts the recorded base core and runs
  the two unchanged-contract characterization cases (3 refusal/repair cycles).
- `npm test` runs:
  - `test/request-reporting.test.ts` — independent aggregation, fresh union
    repair, authorization, mixed outcomes, dependency deferral, adversarial
    omission/false-trace cases, and schema versus runtime coverage negatives.
  - `test/core.test.ts` — reference-implementation behavioral tests
    (constraint evaluation, expiry, EXACT-guarantee-drift detection,
    committed-effect ownership, receipt correlation-chain integrity,
    `aggregateHint` derivation/consistency, and full-lifecycle scenarios
    via `ReferenceProvider`).
  - `test/admission.test.ts` — live retail admission behavior, witness
    honesty/scope, no-dispatch evidence, repair-by-requote, preserved safety
    checks, later mixed/refused/indeterminate outcomes, and reconciliation.
  - `test/schema-conformance.test.ts` — validates every `*.fixture.json`
    file under `/examples` against the core JSON Schema using
    [ajv](https://ajv.js.org/) in strict mode.
- `npm run validate-schema` — compiles `schema/mse-core.schema.json`
  standalone with ajv to catch schema authoring errors independent of any
  fixture.

These checks establish that the schema is internally consistent and that
the reference implementation and domain examples are mutually consistent
with it. They do **not** establish that the schema is *correct* in the
sense of matching real provider needs — that is precisely what external
review is for.

## Known conformance gaps in this repository itself, today

- The retail admission example wires real example-domain proposal → quote →
  admission/commit behavior through `ReferenceProvider`. Travel,
  subscription, and contract-billing remain fixture-only, and no external
  provider integration exists. This is still self-consistency evidence, not
  production validation.
- `AcceptanceConstraint` **can** express a currency-qualified bound (see
  `/spec/normative-spec.md` §4a and `/docs/ambiguities.md` §3) — every
  domain example includes an `acceptance-constraint.fixture.json`
  demonstrating this, including the brief's own `fare_delta <= USD 150`
  example under `/examples/travel`.
- Only `/examples/retail` currently includes a genuinely multi-unit
  fixture (`multi-unit-quote.fixture.json` /
  `multi-unit-commit-result.fixture.json`) demonstrating two units sharing
  an `effectType` with distinct `effectId`s and a mixed `APPLIED`/`REFUSED`
  result. Travel, subscription, and contract-billing examples remain
  single-unit in this revision — extending them to multi-unit scenarios
  was judged to be additional domain-example work beyond what this
  falsification response requires, not a conformance gap in the core
  itself.
