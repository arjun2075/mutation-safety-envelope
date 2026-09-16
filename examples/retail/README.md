# Retail order editing — MSE example

**Status:** modeled/tested example domain. Illustrative only, not part of the MSE core, and not evidence of external validation or industry adoption.

## Scenario

A customer's agent wants to change the shipping method on an existing order
from standard to expedited. The merchant can preview the resulting total
before committing, but on-hand inventory for the (already-reserved) item may
still drift if the merchant does not separately guarantee or reserve it.

## Mapping onto MSE

| MSE concept | Retail instantiation |
|---|---|
| `target` | `{ "orderId": "order_8842" }` |
| `change` | `{ "shippingMethod": "expedited" }` (opaque to the core) |
| Effect `retail:order_total_delta` | Signed amount + ISO 4217 currency the order total changes by |
| Effect `retail:shipping_fee` | The new shipping line-item amount |
| `snapshot` | The order's current version/ETag, so the merchant can detect the customer edited the order again in a second tab before commit |
| `commitConsistency` | `SNAPSHOT_REQUIRED` — a stale order edit must be refused, not silently applied over a newer state |

## What this example deliberately leaves out

Inventory reservation, backorder handling, tax recalculation rules, and
payment re-authorization are all real parts of order editing in production
systems. MSE does not model them; a retail profile that wants to expose them
would define additional, retail-namespaced effect types (e.g.
`retail:inventory_reservation_status`) without changing the core schema.

## Cross-unit admission example (v0.4.0-dev.0)

The executable binding in [`admission-policy.ts`](./admission-policy.ts)
models two provider-reported gates from UCP Discussion #799. The behavior is
attributed evidence; the MSE message shapes are proposed here for review.

- Cancelling the separate delivery unit requires every goods cancellation to
  be included in the request or established by a prior final cancellation.
- Redeeming goods requires delivery redemption in the request or a prior final
  delivery redemption. Submitted, pending, provisional, or failed history is
  insufficient even if a coarse resource state already looks completed.

The quote declares only a stable, directional `REQUIRES_COINCLUSION`
relation. The binding evaluates actual current order state immediately before
dispatch. An admission refusal carries binding-scoped `unitLocator`s and
explicit required transitions. The caller constructs a new proposal and gets
a new quote; it never appends missing units to the old commit request.

Both retail relations declare `passEvidence: REQUIRED`. Their `PASSED`
coverage identifies each participating transition as `CURRENT_REQUEST` or
`PRIOR_FINAL_TRANSITION`; the latter includes a stable transition reference
and finalization timestamp. The same `AdmissionReport` is visible beside a
successful `CommitResult`, so a prior-history pass is not indistinguishable
from a gate that never ran. Retail trace conformance checks the opaque history;
the domain-blind core checks only structure and correlation.

The binding example also demonstrates the authorization boundary: a witness
can describe a required transition that the caller is not permitted to make.
In that case the binding refuses to quote the amended proposal. The witness is
information, not authority.

Passing admission is not atomic success. Tests deliberately allow a required
delivery unit to become `REFUSED` or `INDETERMINATE` after co-inclusion passes;
the complete per-unit result and reconciliation rules remain authoritative.
Preventing that economic outcome would require a stronger binding-level
transaction guarantee that this example does not claim.

## Files

- [`quote.fixture.json`](./quote.fixture.json) — a `MutationQuote` for this scenario, validated in CI against `/schema/mse-core.schema.json`.
- [`acceptance-constraint.fixture.json`](./acceptance-constraint.fixture.json) — an `AcceptanceConstraint` bounding `retail:order_total_delta <= USD 20.00` using the core's `money` `ComparableValue` variant.
- [`admission-refusal.fixture.json`](./admission-refusal.fixture.json) — the
  original proposal, quote, commit request, and complete live witness for two
  missing goods cancellations.
- [`amended-proposal.fixture.json`](./amended-proposal.fixture.json) and
  [`amended-quote.fixture.json`](./amended-quote.fixture.json) — the required
  repair-by-new-proposal/new-quote flow through a successful commit;
  quote-local `unitRef`s change while binding-scoped `unitLocator`s identify
  the same units.
- [`multi-unit-commit-response.fixture.json`](./multi-unit-commit-response.fixture.json)
  — the `COMMIT_RESULT` branch with preserved mixed per-unit outcomes.
