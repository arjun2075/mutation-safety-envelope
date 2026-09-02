# Retail order editing — MSE example

**Status:** illustrative domain example. Not part of the MSE core.

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

## Files

- [`quote.fixture.json`](./quote.fixture.json) — a `MutationQuote` for this scenario, validated in CI against `/schema/mse-core.schema.json`.
- [`acceptance-constraint.fixture.json`](./acceptance-constraint.fixture.json) — an `AcceptanceConstraint` bounding `retail:order_total_delta <= USD 20.00` using the core's `money` `ComparableValue` variant.
