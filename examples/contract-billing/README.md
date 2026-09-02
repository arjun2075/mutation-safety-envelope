# Contract / billing amendment — MSE example

**Status:** illustrative domain example. Not part of the MSE core.

## Scenario

An agent amends a commercial contract's billing terms (e.g. applying a
negotiated credit). The provider exposes a version/hash-based protection
mechanism — an optimistic-concurrency guard — that must detect if the
contract changed underneath the agent between quote and commit.

## Mapping onto MSE

| MSE concept | Contract/billing instantiation |
|---|---|
| `target` | `{ "contractId": "ctr_2201" }` |
| `snapshot` | A content hash of the contract's current terms, e.g. `"sha256:9f...".` |
| `commitConsistency` | `SNAPSHOT_REQUIRED` — this is the domain example that most directly motivates this field; committing an amendment against stale contract terms is a correctness hazard, not just a UX nuisance |
| Effect `contract:credit_amount` | The credit being applied, `guarantee.mode = EXACT` |
| `Receipt` | `mutationOutcome = APPLIED` with `contract:credit_amount` finality `PENDING` until the credit is reflected on the next generated invoice |

## What this example deliberately leaves out

Contract clause taxonomies, legal redlining/versioning workflows, and
invoice generation timing are real billing-domain concerns MSE does not
model.

## Files

- [`quote.fixture.json`](./quote.fixture.json) — validated in CI against `/schema/mse-core.schema.json`.
- [`acceptance-constraint.fixture.json`](./acceptance-constraint.fixture.json) — bounds `contract:credit_amount <= USD 500.00`.
