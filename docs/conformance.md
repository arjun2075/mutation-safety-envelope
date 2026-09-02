# Conformance

**Status:** v0.1.0, external review candidate.

> Conformance here means conformance with **this repository's own** schema
> and normative spec. It is not, and does not imply, conformance with any
> vendor or standards-body specification. See
> [`/docs/DISCLAIMER.md`](./DISCLAIMER.md).
>
> Nothing in this repository's test suite is, or should be described as,
> an official UCP conformance test. See `/ucp-binding` for the (sketch,
> non-normative) relationship to UCP.

## What "conformant" means for a provider

A provider claiming MSE v0.1.0 conformance MUST:

1. Produce `MutationQuote` documents that validate against
   [`/schema/mse-core.schema.json`](../schema/mse-core.schema.json).
2. Treat producing a quote as non-mutating: it MUST NOT commit the
   requested commercial mutation itself. A disclosed, reversible
   reservation/hold (surfaced as an `Effect`) is the one permitted
   exception (see spec §3.1 and `/docs/ambiguities.md` §4).
3. Never mark an `Effect.guarantee.mode` as `EXACT` unless prepared to
   honor it per spec §3.1 and §4.
4. Evaluate every `AcceptanceConstraint` fail-closed per spec §3.2 before
   returning `APPLIED`.
5. Return exactly one of `APPLIED` / `REFUSED` / `INDETERMINATE` from a
   commit attempt, with `refusalReason` present whenever `REFUSED` is
   returned.
6. Never silently alter an `EXACT`-guaranteed effect's value between quote
   and commit; doing so invalidates the `APPLIED` result regardless of
   what outcome value the provider returns (see spec §3.1, and
   `assertExactGuaranteesHonored` in
   [`/src/core/validate.ts`](../src/core/validate.ts), which a reviewer can
   run against a provider's recorded quote/commit pairs to check this
   mechanically).
7. Report `EffectFinality` for downstream effects using `Receipt`, and
   never conflate a `PENDING`/`FAILED`/`UNKNOWN` downstream effect with
   overall mutation failure, or vice versa (spec §3.3).

## What "conformant" does NOT require

A conformant provider is **not** required to:

- support every `GuaranteeMode` for every effect (a provider may choose to
  offer only `UNKNOWN` guarantees if that is honestly all it can offer —
  this is legal, if not very useful to callers);
- support `commitConsistency: SNAPSHOT_REQUIRED` (a provider may declare
  `NONE` if it offers no drift detection at all);
- implement every effect type used in this repository's domain examples —
  those are illustrative, not a required vocabulary.

## Self-check tooling in this repository

- `npm test` runs:
  - `test/core.test.ts` — reference-implementation behavioral tests
    (constraint evaluation, expiry, EXACT-guarantee-drift detection, and
    full-lifecycle scenarios via `ReferenceProvider`).
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

- The domain examples in `/examples` are quote/constraint fixtures; none of
  them wire a full proposal→quote→commit→receipt run through
  `ReferenceProvider` yet. `test/core.test.ts` exercises the full lifecycle
  only with synthetic (non-domain) effect types. See
  [`/docs/readiness-report.md`](./readiness-report.md) for this listed as
  an open risk.
- `AcceptanceConstraint` **can** express a currency-qualified bound as of
  the v0.1.0 hardening pass (see `/spec/normative-spec.md` §4a and
  `/docs/ambiguities.md` §3) — every domain example now includes an
  `acceptance-constraint.fixture.json` demonstrating this, including the
  brief's own `fare_delta <= USD 150` example under `/examples/travel`.
