# Travel / airline reshop — MSE example

**Status:** modeled/tested example domain. Illustrative only, not part of the MSE core, and not evidence of external validation or industry adoption.

## Scenario

An agent wants to move a passenger to a different flight on the same
itinerary. A reshop quote for airline inventory typically bundles several
things whose *validity horizons differ*: the fare delta may be guaranteed
for a short window, seat inventory may not be guaranteed at all until
ticketing, and the payment deadline is a separate constraint entirely. This
is the scenario that most motivated MSE's decision to attach a guarantee to
each *effect* rather than to the quote as a whole.

## Mapping onto MSE

| MSE concept | Travel instantiation |
|---|---|
| `target` | `{ "pnr": "ABC123", "segmentId": "seg_2" }` |
| `change` | `{ "newFlightNumber": "AA123", "newDepartureDate": "2026-10-01" }` |
| Effect `travel:fare_delta` | Signed amount + currency, `guarantee.mode = EXACT` with a short `validUntil` (price guarantee window) |
| Effect `travel:seat_inventory` | `guarantee.mode = REVALIDATE` — seat availability is not guaranteed until commit is attempted |
| Effect `travel:payment_deadline` | `guarantee.mode = EXACT` — informational, not itself commercial, but still a predicted consequence the agent should see |
| `CommitOutcome = INDETERMINATE` | A ticketing call that times out after submission to the GDS/NDC backend — the agent must not blindly retry, because a duplicate ticket may already have been issued |

## What this example deliberately leaves out

Fare rules, change/cancel penalty computation, seat maps, and GDS/NDC
message formats are real and complex. MSE does not model them. A travel
profile would define `travel:*` effect types for whatever it needs to
expose and document their value shapes; the core only requires that each
effect carry a `type`, a `value`, and a `guarantee`.

## Files

- [`quote.fixture.json`](./quote.fixture.json) — a `MutationQuote` showing three effects with three different guarantee modes, validated in CI against `/schema/mse-core.schema.json`.
- [`acceptance-constraint.fixture.json`](./acceptance-constraint.fixture.json) — the brief's own example bound, `fare_delta <= USD 150`, expressed as an enforceable `AcceptanceConstraint` using the core's `money` `ComparableValue` variant (see `/spec/normative-spec.md` §4a). `travel:fare_delta` in the quote is `84.00 USD`, so this constraint is satisfied.
- [`indeterminate-commit.fixture.json`](./indeterminate-commit.fixture.json) — a `CommitResult` illustrating `INDETERMINATE`. See `test/core.test.ts`'s "INDETERMINATE end-to-end" case for this exercised through real code, including that the reference implementation does not respond to it with a blind retry.
