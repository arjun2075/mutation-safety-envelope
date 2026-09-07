# Mutation Safety Envelope (MSE)

**Status:** Experimental / External Review Candidate — v0.4.0-dev.0 (unreleased)
**License:** Apache-2.0

> **v0.4.0-dev.0 is a breaking development revision of v0.3.0.** Required
> admission coverage distinguishes passed/failed relations from repair-dependent
> deferral. The recorded v0.3.0 reproduction needs three refusal/repair cycles;
> independent aggregation reports all three failures together. See the
> [decision](docs/request-reporting-design.md) and [audit](docs/request-reporting-audit.md).
> This is proposed MSE design work, not UCP adoption or endorsement.

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
   ├── per unit: scoped identity + opaque transition + predicted effects
         ├── guarantee per effect   (EXACT | REVALIDATE | UNKNOWN)
         ├── guarantee horizon
         └── acceptance constraints
   └── stable directional admission relations (no frozen witness)
   ↓
Admission against live state
   ├── refused before dispatch → per-relation coverage + failure witnesses
   │                              → amended proposal → new quote
   └── passed (every declared relation evaluated PASSED)
         ↓
Commit  →  one result PER UNIT, not one for the whole mutation:
   ├── unit A: APPLIED
   ├── unit B: REFUSED
   └── unit C: INDETERMINATE        (reconciliation contract — never blind retry)
   ↓
Receipt
   └── per committed effect, effect finality: FINAL | PENDING | FAILED | UNKNOWN
```

MSE distinguishes a pre-dispatch admission gate plus three separate safety
questions that a single `SUCCESS` flag collapses: **quote stability**,
**admission validity**, **commit determinacy** (per independently
committing unit), and **effect finality**. Admission is not a fourth commit
outcome; it is the known no-dispatch branch. See
[`/spec/normative-spec.md`](spec/normative-spec.md) §1d, §2, §3.2.

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
  readiness-report.md      Publication readiness report and revision history
  v0.2-review-response.md  Historical per-unit outcomes + reconciliation response
  v0.3-design-decision.md  Admission response and repair-by-requote decision
  v0.3-review-response.md  Traceability for the live-witness iteration
  v0.3-audit-report.md     Semantic and consistency self-review findings
  request-reporting-design.md  v0.4.0-dev.0 coverage decision
  request-reporting-audit.md   Request-level semantic/consistency audits
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
npm test                # 175 current-contract tests
npm run test:baseline   # 2 separate cases against recorded v0.3.0 core
npm run build            # tsc typecheck/build
npm run validate-schema  # compiles the JSON Schema standalone under ajv strict mode
```

## Before you rely on this

This is a v0.4.0-dev.0 development revision, not a finished or
production-hardened specification. Start with:

1. [`/docs/DISCLAIMER.md`](docs/DISCLAIMER.md) — what MSE is not.
2. [`/docs/v0.3-review-response.md`](docs/v0.3-review-response.md) — what
   the later stable-relation/live-witness feedback changed, and what it did
   not establish.
3. [`/docs/v0.2-review-response.md`](docs/v0.2-review-response.md) — the
   preserved historical response on per-unit outcomes and reconciliation.
4. [`/docs/v0.3-audit-report.md`](docs/v0.3-audit-report.md) — adversarial
   semantic and cross-artifact consistency findings.
5. [`/docs/ambiguities.md`](docs/ambiguities.md) — resolved and open design
   questions, including remaining concurrency and shared-effect limits.
6. [`/docs/falsification-notes.md`](docs/falsification-notes.md) — what has
   and has not actually been tested.
7. [`/docs/readiness-report.md`](docs/readiness-report.md) — the
   publication readiness report, covering both the v0.1.0 publication and
   the historical v0.3.0 revision's status; current findings are in the request-reporting audit.

## Review question

> Can a domain-blind safety layer represent real commercial mutations
> across multiple industries without absorbing domain-specific workflow
> semantics?

The goal of external review is falsification, not promotion.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
