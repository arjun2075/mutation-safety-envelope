# UCP binding sketch (non-normative)

**Status:** experimental sketch, not a proposal endorsed or reviewed by any
UCP maintainer. See [`/docs/DISCLAIMER.md`](../docs/DISCLAIMER.md).

## Purpose

This document sketches how MSE's core concepts *could* map onto a
UCP-style commerce protocol capability, so that UCP maintainers have a
concrete artifact to react to when deciding whether mutation safety
belongs as a reusable UCP primitive. It is explicitly a question, not an
answer:

> Can a domain-blind safety layer represent real commercial mutations
> across multiple industries without absorbing domain-specific workflow
> semantics? — and if so, does it belong inside UCP, or alongside it?

## Posture

Per the source handoff brief, the preferred posture for this repository is:

1. Keep MSE protocol-neutral (done — see `/schema` and `/spec`).
2. Provide a UCP binding or experimental vendor capability/service sketch
   (this document).
3. Ask UCP maintainers whether mutation safety belongs as a reusable UCP
   primitive — this has now happened once: this repository was shared and
   discussed in UCP Discussion #799, which raised substantive technical
   criticism of the v0.1.0 core (see
   [`/docs/v0.2-review-response.md`](../docs/v0.2-review-response.md)).
   That the discussion occurred, and that its findings were addressed, is
   **not** a claim that UCP maintainers have endorsed, adopted, or
   co-authored MSE, or that mutation safety has been accepted as a UCP
   primitive — see [`/docs/DISCLAIMER.md`](../docs/DISCLAIMER.md), which
   still fully applies. Further outreach and discussion remain open.
4. Do not distort MSE merely to fit UCP (see below — this sketch is
   intentionally marked incomplete where a forced fit would require
   compromising the core).
5. Do not create another generic "agent-to-commerce" protocol — this
   sketch only proposes a capability *binding*, not a competing protocol.

## Sketch: MSE as a UCP capability

*Illustrative only — field and capability names below are invented for
this sketch and are not existing UCP identifiers.*

```text
Capability: "mutation-safety" (proposed, unregistered)

Operations:
  mse.quote(proposal: MutationProposal) -> MutationQuote
  mse.commit(request: CommitRequest) -> CommitResult
  mse.receipt(quoteId: string) -> Receipt
```

A UCP-integrated provider that supports this capability would advertise it
alongside its existing commerce capabilities, and an agent negotiating with
that provider would use the existing UCP transport/session/identity layer
to carry `MutationProposal`/`MutationQuote`/`CommitRequest`/`CommitResult`
payloads, validated against `/schema/mse-core.schema.json`. As of v0.2.0,
`mse.commit`'s result carries `unitResults` (one outcome per independently
committing unit, not a single mutation-wide outcome — see
`/spec/normative-spec.md` §1a-§1c) and an `INDETERMINATE` unit's
`reconciliation` field would need its `MACHINE_RESOLVABLE`/
`AUTHORITATIVE_READ` invocation path mapped onto whatever reconciliation
or status-check operation UCP's own transport affords — see the next
section for why this sketch does not attempt to guess at that mapping.

## What this sketch deliberately does not attempt

- It does not define how `mse.quote`/`mse.commit`/`mse.receipt` would be
  named, versioned, or negotiated within actual UCP capability discovery,
  because that is UCP's design surface, not MSE's, and guessing at it here
  would risk exactly the "distort MSE to fit UCP" failure mode the brief
  warns against.
- It does not address how UCP's own identity/session model would satisfy
  MSE's implicit assumption that the entity calling `commit` is the same
  (or an authorized delegate of the same) entity that received the quote —
  this is exactly the kind of question meant to be posed *to* UCP
  maintainers, not decided unilaterally here.

## Status of outreach

This sketch and repository were discussed in UCP Discussion #799, which
raised the two substantive findings addressed in v0.2.0 (see
[`/docs/v0.2-review-response.md`](../docs/v0.2-review-response.md)). This
is one round of outreach and discussion, not a completed or closed
process, and not an endorsement — see
[`/docs/DISCLAIMER.md`](../docs/DISCLAIMER.md). Whether UCP maintainers
consider mutation safety a candidate reusable primitive remains an open
question posed *to* them, not answered *for* them by this repository.
Further outreach on the v0.2.0 shapes specifically (`CommittingUnit`,
`UnitResult`, `Reconciliation`, `effectId`) has not yet occurred as of
this revision.
