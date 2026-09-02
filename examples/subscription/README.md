# Subscription change — MSE example

**Status:** illustrative domain example. Not part of the MSE core.

The handoff brief that seeded this repository notes that subscription
changes were the *original* domain used to investigate this safety pattern,
but that subscription semantics are explicitly **not** part of the MSE
core. This example exists to show the same lifecycle applied to a different
domain, and to make it obvious that no subscription-specific concept (plan,
billing period, proration rule, cancellation policy) leaked into `/schema`
or `/src/core`.

## Scenario

An agent increases a subscription's seat count mid-billing-cycle. The
provider must preview the prorated charge before committing.

## Mapping onto MSE

| MSE concept | Subscription instantiation |
|---|---|
| `target` | `{ "subscriptionId": "sub_5591" }` |
| `change` | `{ "seatCount": { "from": 10, "to": 15 } }` |
| Effect `subscription:recurring_amount` | The new recurring charge amount, `guarantee.mode = EXACT` |
| Effect `subscription:proration_credit` | The one-time prorated charge for the remainder of the cycle, `guarantee.mode = EXACT` |
| `AcceptanceConstraint` | `subscription:recurring_amount <= USD 2000`, matching the handoff brief's example bound — see [`acceptance-constraint.fixture.json`](./acceptance-constraint.fixture.json), expressed as an enforceable `money` `ComparableValue` bound |

## What this example deliberately leaves out

Proration algorithms, billing-cycle anchoring, dunning/retry policy on
failed recurring charges, and plan-tier eligibility rules are all real
subscription-domain concerns. None of them belong in the MSE core.

## Files

- [`quote.fixture.json`](./quote.fixture.json) — validated in CI against `/schema/mse-core.schema.json`.
- [`acceptance-constraint.fixture.json`](./acceptance-constraint.fixture.json)
