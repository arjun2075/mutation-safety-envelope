# Publication readiness report — v0.1.0

Prepared per requirement 11 of the source handoff brief
(`MSE_AGENT_HANDOFF.md` → "Instructions for another coding/research agent").
**This repository has not been pushed publicly.** This report is the
pre-publication gate the handoff brief asked for; publication requires a
separate, explicit go-ahead.

## 1. Unresolved semantics

See [`/docs/ambiguities.md`](./ambiguities.md) for full detail. Summary,
ranked by how load-bearing each gap is:

1. **`AcceptanceConstraint` cannot express currency-qualified bounds**
   (ambiguities §3). This is the most serious gap: every monetary example
   in the source brief (`fare_delta <= USD 150`, etc.) cannot actually be
   enforced end-to-end by the core as specified. High priority for
   pre-v1.0 resolution.
2. **`RefusalReason` is a closed enum** (ambiguities §1) — likely too
   restrictive for real providers.
3. **Partial `effectReceipts` have no "intentionally untracked" signal**
   (ambiguities §2).
4. **"Non-mutating quote" boundary is undefined** for soft-hold-style side
   effects common in travel inventory (ambiguities §4).
5. **Concurrent-quote / universal-snapshot-update assumption is implicit,
   not enforced** (ambiguities §5) — a real security-relevant gap if a
   provider updates its MSE snapshot only on MSE-issued commits.

## 2. Unsupported claims

- The repository does **not** claim vendor endorsement from UCP, ACP,
  Shopify, Salesforce, IATA, Paid, Stripe, Paddle, Zuora, or Chargebee (per
  requirement 9). Verified: `grep`-checked below.
- The repository does **not** claim its tests are official UCP conformance
  tests (per requirement 10) — `/docs/conformance.md` and
  `/ucp-binding/README.md` explicitly disclaim this.
- The repository does **not** claim MSE has been validated against a real
  (non-reference) provider. See `/docs/falsification-notes.md` §"What has
  NOT been checked," item 1 — this is the largest gap between what the
  schema/tests establish and what a reader might assume they establish.
- The repository does **not** claim the four domain examples are complete
  or production-representative of their domains; each example's README
  states what it deliberately leaves out.

Verification command run against the working tree before this report:

```bash
grep -rniE "official (ucp|acp|shopify|salesforce|iata|paid|stripe|paddle|zuora|chargebee)|endorsed by|certified by" \
  --include='*.md' --include='*.json' --include='*.ts' --exclude-dir=node_modules .
```

Result: no matches other than the negation statements themselves (e.g. "is
NOT an official ... specification") in DISCLAIMER.md, README.md, and
spec/normative-spec.md.

## 3. Test results

Run at repository preparation time:

```text
npm test

 ✓ test/core.test.ts (18 tests)
 ✓ test/schema-conformance.test.ts (7 tests)

 Test Files  2 passed (2)
      Tests  25 passed (25)
```

```text
npx tsc -p tsconfig.json --noEmit
(no output — clean typecheck)
```

Coverage characterization (qualitative, no coverage tool configured yet):
constraint fail-closed rules (4 sub-cases), quote expiry (3 sub-cases),
EXACT-guarantee drift detection (4 sub-cases), and full-lifecycle
APPLIED/REFUSED(×2 reasons)/PENDING-downstream scenarios via
`ReferenceProvider`, plus schema-conformance validation of all four domain
fixtures. Not covered: `INDETERMINATE` end-to-end via `ReferenceProvider`
(the reference provider never itself returns `INDETERMINATE` — it is only
exercised as a standalone fixture in `/examples/travel`, so no test
currently proves a provider transitioning into that state through real
code, only that the *shape* validates). This is a real test-plan gap, not
an oversight to bury — see `/test/README.md`'s stated future work.

## 4. Dependency / license scan

- Runtime: the reference implementation (`src/core`) has **zero runtime
  dependencies** — it is plain TypeScript compiled to plain JS/types.
- Dev-only dependencies (`vitest`, `ajv`, `ajv-formats`, `typescript`,
  `tsx`, `@types/node`): `npm audit` reports 5 vulnerabilities (3 moderate,
  1 high, 1 critical), all in `esbuild`/`vite`/`vite-node`, transitive
  dependencies of `vitest`'s dev server. These affect only the local
  development/test-running experience (a dev server accepting requests from
  arbitrary origins) and are not present in anything this repository
  publishes or ships at runtime. Recorded here rather than silently fixed
  with a breaking `vitest@4` upgrade, since that upgrade was not requested
  and could itself introduce test-behavior changes worth reviewing
  separately.
- License: repository targets Apache-2.0 per requirement 6. `LICENSE` file
  added at repository root. No dependency in `package.json` has been
  audited line-by-line for license compatibility with Apache-2.0 as part of
  this pass — flagged as a remaining step, not performed, since dev-only
  tooling licenses (MIT/ISC/BSD for vitest/ajv/typescript, all
  Apache-2.0-compatible as commonly understood) were not deeply verified
  here.
- No project git history was imported; this repository was initialized
  fresh (`git init`) with no prior commits, per requirement 2.
- No SCQ or subscription-specific code was imported as a dependency; the
  subscription example was written fresh against the core schema, per
  requirement 1.

## 5. Secret / privacy scan

```bash
grep -rniE "api[_-]?key|secret|password|bearer |authorization: |-----BEGIN" \
  --include='*.md' --include='*.json' --include='*.ts' --exclude-dir=node_modules .
```

Result: no matches. All identifiers in fixtures (`order_8842`, `ABC123`,
`sub_5591`, `ctr_2201`) are synthetic placeholders invented for this
repository, not real account, order, or contract identifiers. No email
addresses, tokens, or credentials appear anywhere in the tree.

## 6. Remaining review risks (for the person deciding whether to publish)

1. The monetary-constraint gap (§1.1 above) means the most commercially
   obvious use case in the source brief's own examples cannot be
   demonstrated end-to-end today. Consider resolving this, or at minimum
   making it more prominent than a buried doc section, before external
   review — it is the first thing a sharp reviewer will find.
2. All validation to date is self-consistency (schema ↔ reference
   implementation ↔ fixtures written by the same process). No independent
   party has tried to break this. Publication is the mechanism for getting
   that independent pressure — but expect the first round of real feedback
   to surface issues beyond the five already listed in `/docs/ambiguities.md`.
3. The UCP binding sketch has not been shown to any UCP maintainer. If the
   intent is to eventually ask UCP whether mutation safety belongs as a
   primitive (per the source brief), that outreach is a distinct next step
   this report cannot perform.
4. `npm audit` findings (dev-tooling only) should be re-checked
   immediately before publishing in case newer patched versions have
   landed, since this scan has a shelf life.
5. Repository name and description in `package.json`/`README.md` follow the
   source brief's suggestions verbatim
   (`mutation-safety-envelope`, "Experimental safety envelope for
   agent-initiated mutations to existing commercial state"); confirm these
   still match intent before publishing under a different name or org.

## Recommendation

Content is internally consistent, typechecks, and passes its own test
suite (25/25). The repository is **ready for a human go/no-go decision on
publication**, contingent on the reviewer being comfortable that ambiguity
#1 (monetary constraints) is disclosed clearly enough to publish alongside
rather than requiring a fix first. Per the source brief's explicit
instruction and this task's scope, **no push to a public repository has
been performed.**
