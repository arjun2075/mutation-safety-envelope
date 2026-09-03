# Mutation Safety Envelope (MSE)

**Status:** Experimental / External Review Candidate — v0.2.0
**License:** Apache-2.0

> **v0.2.0 is a breaking revision of v0.1.0**, made in direct response to
> external technical falsification (UCP Discussion #799). See
> [`/docs/v0.2-review-response.md`](docs/v0.2-review-response.md) for what
> was falsified and what changed, and
> [`/spec/normative-spec.md`](spec/normative-spec.md) §9 for the exact
> compatibility break. This is evidence-driven revision, not a claim of
> UCP adoption or endorsement.

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
Quote (one or more independently committing units)
   └── per unit: predicted effects
         ├── guarantee per effect   (EXACT | REVALIDATE | UNKNOWN)
         ├── guarantee horizon
         └── acceptance constraints
   ↓
Commit  →  one result PER UNIT, not one for the whole mutation:
   ├── unit A: APPLIED
   ├── unit B: REFUSED
   └── unit C: INDETERMINATE        (reconciliation contract — never blind retry)
   ↓
Receipt
   └── per committed effect, effect finality: FINAL | PENDING | FAILED | UNKNOWN
```

MSE distinguishes three separate safety questions that a single `SUCCESS`
flag collapses: **quote stability**, **commit determinacy** (now per
independently committing unit, as of v0.2.0), and **effect finality**. See
[`/spec/normative-spec.md`](spec/normative-spec.md) §2, §1a-§1c.

## Repository layout

```text
/schema             Normative JSON Schema (draft 2020-12) — the actual contract
/spec               Normative spec prose: lifecycle rules, guarantee semantics (incl. money), open issues
/src/core           TypeScript reference types + validation helpers + a minimal in-memory provider
/scripts            Standalone tooling, e.g. strict-mode schema compile check
/test               Behavioral tests (vitest) + schema-conformance tests (ajv) over /examples
/examples           Four modeled/tested example domains: retail, travel, subscription, contract-billing
                    — each with a quote fixture and an enforceable monetary AcceptanceConstraint fixture.
                    These are illustrative examples only, not evidence of external validation or adoption.
/ucp-binding        Non-normative sketch of MSE as a UCP capability
/docs
  DISCLAIMER.md            Independent-research disclaimer (read this first)
  ambiguities.md           Open ambiguities in the source design, surfaced deliberately
  security-considerations.md
  conformance.md
  falsification-notes.md   What's been tested, what hasn't, what would falsify the hypothesis
  readiness-report.md      Publication readiness report, v0.1.0 and v0.2.0 status
  v0.2-review-response.md  What UCP Discussion #799 falsified in v0.1.0, and what changed
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
npm test                # runs behavioral + schema-conformance tests (84 as of v0.2.0)
npm run build            # tsc typecheck/build
npm run validate-schema  # compiles the JSON Schema standalone under ajv strict mode
```

## Before you rely on this

This is a v0.2.0 external-review candidate, not a finished or
production-hardened specification. Start with:

1. [`/docs/DISCLAIMER.md`](docs/DISCLAIMER.md) — what MSE is not.
2. [`/docs/v0.2-review-response.md`](docs/v0.2-review-response.md) — what
   external review (UCP Discussion #799) falsified in v0.1.0's
   mutation-wide commit outcome and undefined `INDETERMINATE` resolution
   path, and what changed in response.
3. [`/docs/ambiguities.md`](docs/ambiguities.md) — known design questions
   across both revisions; three remain genuinely open (concurrent quotes,
   per-unit consistency policy, cross-unit shared effects).
4. [`/docs/falsification-notes.md`](docs/falsification-notes.md) — what has
   and has not actually been tested.
5. [`/docs/readiness-report.md`](docs/readiness-report.md) — the
   publication readiness report, covering both the v0.1.0 publication and
   the current v0.2.0 revision's status.

## Review question

> Can a domain-blind safety layer represent real commercial mutations
> across multiple industries without absorbing domain-specific workflow
> semantics?

The goal of external review is falsification, not promotion.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
