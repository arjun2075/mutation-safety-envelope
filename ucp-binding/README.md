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
   primitive (not yet done — this repository has not been shared with UCP
   maintainers as of v0.1.0. That outreach is a follow-up action, not
   something this document can perform on its own).
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
to carry `MutationProposal`/`MutationQuote`/`CommitRequest` payloads,
validated against `/schema/mse-core.schema.json`.

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

As of v0.1.0, this sketch has not been submitted to or discussed with UCP
maintainers. Publishing this repository is not the same act as making that
ask — see [`/docs/readiness-report.md`](../docs/readiness-report.md) for
this listed explicitly as a remaining step.
