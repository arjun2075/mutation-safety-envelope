# Request-level admission reporting decision

Base: `main` at `b39cc8f9cb599f2550dc177a98f9f26eeae1d3b1`.
Branch: `codex/request-admission-reporting`. No applicable AGENTS.md was found.

## Evidence before contract edits

With unchanged base core source, `node scripts/reproduce-v0.3.mjs` passes two
characterization cases: three independent orders need **3 refusal/repair
cycles and 4 quotes**, with locally COMPLETE witnesses and zero dispatches
on each refusal. The exhaustive evaluator returns three failures; deleting C
still passes the base refusal validator. This script extracts the recorded
core from Git into a temporary directory, so the reproduction remains runnable
after the working contract changes. It does not emulate the old validator.

## Normative audit and decision gate

1. §3.2 already says providers “MUST evaluate every applicable quote-declared”
   relation. Independent fail-fast evaluation violates that obligation even
   though the base reference provider and validator accept its response.
   `failures` already supports aggregation. No schema change is needed merely
   to return three independent failures together.
2. Quote + response + a trustworthy provider evaluation trace can establish
   whether every independent failure was reported. Quote + response alone
   cannot determine whether omitted C passed, was deferred, or was skipped.
   An intentionally false trace cannot be disproved by a domain-blind core.
3. A legitimate dependency cannot be reported as a known failure with
   UNAVAILABLE repair: the relation has not been evaluated. A wire-visible
   representation is needed for the requested caller distinction. Add required
   `coverage` entries naming every declared relation exactly once, with status
   PASSED, FAILED, or DEFERRED. Only DEFERRED carries nonempty `dependsOn`
   relation IDs. FAILED entries correspond exactly to failures. Omitted entries
   (including early stop) are invalid; there is no exhaustive boolean to trust.
   PASSED means evaluated with no failure, including evaluated inapplicability.
4. Coverage describes one admission evaluation pass of one quoted request at
   its evaluated binding state, not all future proposals or a locked snapshot.
   Independently evaluable relations MUST be evaluated in that pass. A deferred
   relation needs a real binding dependency on repair of another relation;
   dependencies must lead to a reported failure, with no cycles or passed roots.
   Coverage, failure, and dependency arrays are identity-correlated sets; their
   order has no semantic meaning.
5. Under unchanged independent fixture state, union repair needs one refusal
   round trip. No general round-trip bound follows: new state, newly activated
   dependencies, partial repairs, authorization, and later per-unit execution
   can prevent success. COMPLETE remains local to a relation and evaluated state.

No generic workflow language or domain vocabulary is added to core. The
reference hook must supply coverage even on a successful check. A missing hook
or malformed/incomplete coverage throws before dispatch; it cannot fabricate
failed relations with UNAVAILABLE witnesses. COMMIT_RESULT remains unchanged:
quote-level rejection can occur before admission, so that branch alone does
not assert admission was performed.

## Compatibility

Recommend and use **0.4.0-dev.0**, after the executable decision gate, because
required refusal coverage changes the closed wire schema, public TypeScript
shape, and provider hook contract. This is a breaking pre-1.0 minor development
revision, not a published release. v0.3.0 tags and historical documents remain
unchanged. Migration: return actual coverage for every declared relation;
provide dependencies for deferred evaluation; validate failure correspondence;
never derive PASSED merely from absence in a potentially incomplete failure list.
