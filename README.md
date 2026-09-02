# Mutation Safety Envelope (MSE)

**Status:** Experimental / External Review Candidate — v0.1.0
**License:** Apache-2.0

> MSE is **not** an official specification of UCP, ACP, Shopify, Salesforce,
> IATA, Paid, Stripe, Paddle, Zuora, Chargebee, or any other vendor or
> standards body. It is an independent research proposal. See
> [`/docs/DISCLAIMER.md`](docs/DISCLAIMER.md).

## What this is

Mutation Safety Envelope (MSE) is a domain-blind safety contract that lets
an autonomous agent preview the consequences of changing existing
commercial state, evaluate those consequences against bounded constraints,
commit the change, and distinguish committed state from unfinished
downstream effects.

Commerce systems increasingly let agents modify existing commercial state —
edit an order, change an itinerary, modify a subscription, amend a billing
contract, cancel or partially change an existing commitment. A successful
API call does not, by itself, tell an autonomous agent what was predicted,
what was guaranteed, whether the mutation definitely happened, or whether
downstream effects like refunds are final. MSE standardizes that safety
boundary without standardizing the underlying commerce domain.

## The core claim, in one diagram

```text
Proposal
   ↓
Quote
   ├── predicted effects
   ├── guarantee per effect        (EXACT | REVALIDATE | UNKNOWN)
   ├── guarantee horizon
   └── acceptance constraints
   ↓
Commit
   ├── APPLIED
   ├── REFUSED
   └── INDETERMINATE               (do not blindly retry)
   ↓
Receipt
   └── effect finality: FINAL | PENDING | FAILED | UNKNOWN
```

MSE distinguishes three separate safety questions that a single `SUCCESS`
flag collapses: **quote stability**, **commit determinacy**, and **effect
finality**. See [`/spec/normative-spec.md`](spec/normative-spec.md) §2.

## Repository layout

```text
/schema             Normative JSON Schema (draft 2020-12) — the actual contract
/spec               Normative spec prose: lifecycle rules, guarantee semantics, open issues
/src/core           TypeScript reference types + validation helpers + a minimal in-memory provider
/test               Behavioral tests (vitest) + schema-conformance tests (ajv) over /examples
/examples           Four illustrative domain profiles: retail, travel, subscription, contract-billing
/ucp-binding        Non-normative sketch of MSE as a UCP capability
/docs
  DISCLAIMER.md            Independent-research disclaimer (read this first)
  ambiguities.md           Open ambiguities in the source design, surfaced deliberately
  security-considerations.md
  conformance.md
  falsification-notes.md  What's been tested, what hasn't, what would falsify the hypothesis
  readiness-report.md     Pre-publication readiness report (see below)
```

## What MSE does not define

Identity, authentication, delegation, payment authorization, transport,
HTTP conditional requests, generic idempotency systems, order/subscription/
travel resource schemas, inventory reservation, refunds, fulfillment,
payment settlement, or procurement. MSE composes with existing protocols
and provider APIs; it does not replace them. See
[`/spec/normative-spec.md`](spec/normative-spec.md) §1.

## Architecture: core vs. profiles

```text
             Mutation Safety Envelope
                      │
        ┌─────────────┼─────────────┐
        ↓             ↓             ↓
      Retail        Travel      Subscription
      profile       profile       profile
```

The core owns safety semantics. Profiles/adapters own commercial
vocabulary. The core schema contains no SKUs, fares, plans, billing
periods, seat counts, or refund rules — see `/examples` for how four
different domains instantiate the same core without adding to it.

## Getting started

```bash
npm install
npm test              # runs behavioral + schema-conformance tests
npm run validate-schema  # compiles the JSON Schema standalone
```

## Before you rely on this

This is a v0.1.0 external-review candidate, not a finished or
production-hardened specification. Start with:

1. [`/docs/DISCLAIMER.md`](docs/DISCLAIMER.md) — what MSE is not.
2. [`/docs/ambiguities.md`](docs/ambiguities.md) — known open design
   questions, including at least one (structured/currency acceptance
   constraints) that is currently load-bearing and unresolved.
3. [`/docs/falsification-notes.md`](docs/falsification-notes.md) — what has
   and has not actually been tested.
4. [`/docs/readiness-report.md`](docs/readiness-report.md) — the
   pre-publication readiness report prepared alongside this repository.

## Review question

> Can a domain-blind safety layer represent real commercial mutations
> across multiple industries without absorbing domain-specific workflow
> semantics?

The goal of external review is falsification, not promotion.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
