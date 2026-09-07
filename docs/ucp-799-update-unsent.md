# UCP #799 update — UNSENT

Local review draft for `codex/request-admission-reporting`, based on
`b39cc8f9cb599f2550dc177a98f9f26eeae1d3b1`. Nothing has been posted.
The branch URLs resolve after the authorized review-branch push. Before sending,
replace them with immutable commit links and rerun verification if anything changes.
Local sources: [characterization](../test/baseline/request-reporting.case.ts),
[batch binding](../test/bindings/merchant-batch.ts),
[new cases](../test/request-reporting.test.ts),
[decision](request-reporting-design.md), [audits](request-reporting-audit.md).

---

Weston, I reproduced the request-level gap from your
[comment](https://github.com/Universal-Commerce-Protocol/ucp/discussions/799#discussioncomment-18333477)
against MSE's unchanged v0.3.0 core. A merchant-scoped request across three
orders takes three refusal/repair cycles and four quotes with fail-fast
evaluation, despite every reported witness being COMPLETE for its own relation.
Every refusal dispatches zero commercial mutations.

The normative audit matters here: v0.3.0 already requires evaluation of every
applicable declared relation, and its failures array already accommodates all
three failures. Independent fail-fast therefore violates the prose even though
the reference validator accepted it. The executable exhaustive case returns
all three failures together; their union can form one newly authorized proposal
and new quote that passes admission under unchanged fixture state.

The additional gap is caller-visible coverage. An omitted relation could have
passed, been skipped, or depend on a prior repair. The local proposal adds one
required coverage entry per declared relation: PASSED, FAILED, or DEFERRED with
identifiable repair dependencies. It keeps that separate from COMPLETE/PARTIAL/
UNAVAILABLE/NOT_REPAIRABLE repair information. The dependent case leaves B
unevaluated until A's repair supplies its input in a new proposal; B can then
fail in its own right. It never evaluates B against invented repaired state.

This required schema/type/hook change warrants a breaking pre-1.0 development
minor, 0.4.0-dev.0; v0.3.0 remains unchanged. Shape checks catch omissions and
contradictions, but a binding trace is still needed to establish truthful
PASSED or DEFERRED claims. There is no general bound on repair round trips under
state changes or newly activated dependencies. Witnesses grant neither authority
nor atomic execution: a repaired request can still have mixed per-unit outcomes.

Evidence: [base reproduction](https://github.com/arjun2075/mutation-safety-envelope/blob/codex/request-admission-reporting/test/baseline/request-reporting.case.ts),
[request-level cases](https://github.com/arjun2075/mutation-safety-envelope/blob/codex/request-admission-reporting/test/request-reporting.test.ts),
[normative decision](https://github.com/arjun2075/mutation-safety-envelope/blob/codex/request-admission-reporting/docs/request-reporting-design.md),
and [two audit passes and verification](https://github.com/arjun2075/mutation-safety-envelope/blob/codex/request-admission-reporting/docs/request-reporting-audit.md).
175 current-contract tests and two separately run base-characterization cases
pass (177 total across the two invocations), as do build and strict schema
validation. This is proposed MSE work informed by your observation,
not a claim that your provider implements this response shape or that UCP has
adopted it.
