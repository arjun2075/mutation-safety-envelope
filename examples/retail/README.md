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

A satisfied gate is therefore not a claim that the satisfaction took effect.
When the request itself supplies the satisfier, a caller acceptance constraint
can refuse exactly that unit, leaving a truthful `PASSED` entry whose cited
transition the same response reports `REFUSED`. Admission-time coverage is not
rewritten; the execution-time reading is derived by correlating each
`CURRENT_REQUEST` record with its `unitResult` (`APPLIED` realized, `REFUSED`
not realized, `INDETERMINATE` indeterminate). See
[`/spec/normative-spec.md` §3.2a](../../spec/normative-spec.md). The dependent
unit is still not required to wait for its satisfier to be applied.

Each `PASSED` entry for these gates also states the complete participant set
the evaluation required, so evidence citing only one of two required goods
cancellations is rejected rather than silently accepted. Evidence must match
a required participant by unit **and** transition, so a cancellation never
discharges a required redemption on the same unit.

Core does **not** infer which units participate. These gates are a good
illustration of why: an order-scoped proposal may redeem `goods_1`, cancel
`goods_2`, and redeem `delivery` in one request, and only `delivery`
participates in the goods-redeem relation even though all three share the
order scope. Semantic completeness of the stated set is therefore this
binding's obligation: its trace conformance re-derives the required set from
real state and rejects a forged one that core, seeing only an internally
consistent report, cannot disprove.

## Binding contracts this example defines

These are retail/reference-binding decisions, not generic MSE requirements.
The core protocol permits a range of conformant behavior here; this binding
picks one canonical representation so trace conformance can check against a
defined answer rather than rejecting another truthful witness by accident.

- **Evidence-source precedence.** When a required participant is satisfied
  both by a valid prior final occurrence and by the same transition present
  again in the current request, this binding cites the **prior final**
  evidence. A redundant current attempt can still end `REFUSED` or
  `INDETERMINATE`, and reporting it would make a relation that was already
  satisfied historically read as unrealized. Current-request evidence is
  used only when no semantically sufficient prior occurrence exists.
- **`transitionRef` identity.** Within one binding-scoped unit, a
  `transitionRef` identifies exactly one historical occurrence. A history
  reusing a ref fails closed, because an ambiguous citation cannot be
  authenticated. Scope is `(unitLocator, transitionRef)`; the core protocol
  does not declare `transitionRef` globally scoped, so the same ref may
  appear on unrelated units.
- **Historical qualification.** A candidate must be `FINAL`, match the
  required transition, carry a `finalizedAt` satisfying the same ISO
  date-time contract core enforces, and have finalized at or before the
  evaluation instant. Qualifying on the shared validator rather than bare
  `Date.parse` matters: a date-only string parses in JavaScript but is not
  a date-time, and selecting it would emit evidence core rejects.
- **Canonical selection.** Among several qualifying occurrences, this
  binding cites the greatest finalization instant, with ordinal
  `transitionRef` as tiebreak. Trace conformance enforces that rule, so a
  truthful but non-canonical citation is rejected as non-canonical, not as
  untruthful.

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
- [`unrealized-satisfaction.fixture.json`](./unrealized-satisfaction.fixture.json)
  — the UCP #799 counterexample: admission passes on a delivery redeem present
  in the request, a caller constraint refuses that delivery unit, and `goods_1`
  is `APPLIED`. The entry stays `PASSED` because it is true about admission;
  correlating the record with `unitResults` yields `NOT_REALIZED`. The derived
  verdict is deliberately absent from the fixture because it is not admission
  wire data.
