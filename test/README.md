# Tests

- `core.test.ts` — behavioral tests for `/src/core`: fail-closed acceptance
  constraint evaluation, quote expiry, EXACT-guarantee drift detection, and
  full-lifecycle scenarios (`APPLIED`, two `REFUSED` reasons, and a
  `PENDING` downstream effect) run against `ReferenceProvider`.
- `schema-conformance.test.ts` — validates every `*.fixture.json` file
  under `/examples` against `/schema/mse-core.schema.json` using ajv in
  strict mode.

## Known gap: no `INDETERMINATE` test through `ReferenceProvider`

`ReferenceProvider` never itself produces `INDETERMINATE` — it always
resolves a commit to `APPLIED` or `REFUSED`, since it has no network layer
to time out. `INDETERMINATE` is currently only exercised as a static schema
fixture (`/examples/travel/indeterminate-commit.fixture.json`), which
proves the shape validates but not that any code path produces it
correctly under a simulated failure. A future revision should add a
`DriftSimulator`-style fault-injection hook to `ReferenceProvider` (e.g. a
`simulateTimeout` flag on `commit()`) so this can be tested end-to-end
rather than only as a fixture. Tracked here rather than silently omitted —
see also `/docs/readiness-report.md` §3.

## Running

```bash
npm install
npm test
```
