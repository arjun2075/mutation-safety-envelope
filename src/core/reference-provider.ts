/**
 * Mutation Safety Envelope (MSE) — reference provider, v0.2.0.
 *
 * A minimal, in-memory, domain-blind implementation of the MSE lifecycle.
 * This exists to (a) prove the schema is implementable and (b) give the
 * test suite and domain examples something real to run against. It is
 * NOT a production commerce engine and holds no domain knowledge — every
 * domain example (retail/travel/subscription/contract) supplies its own
 * effect-generation logic via the `quoter` function passed to the
 * constructor.
 *
 * This is reference behavior, not the only legal implementation.
 *
 * v0.2.0 change: commit processing is now per CommittingUnit, producing
 * one UnitResult per unit rather than a single mutation-wide outcome.
 * Fault injection is scoped per unit and reconciliation can resolve to
 * APPLIED, REFUSED, or remain unresolved — it does not deterministically
 * become APPLIED, because a real reconciliation/authoritative-read path
 * can discover that a mutation did NOT apply. See
 * /docs/v0.2-review-response.md.
 */

import type {
  CommitRequest,
  CommitResult,
  CommittingUnit,
  Effect,
  MutationProposal,
  MutationQuote,
  Receipt,
  EffectReceipt,
  UnitResult,
  Reconciliation,
} from "./types";
import {
  evaluateAcceptanceConstraints,
  isQuoteExpired,
  assertQuoteUnitsWellFormed,
  computeAggregateHint,
} from "./validate";

export type Quoter = (proposal: MutationProposal) => Omit<MutationQuote, "quoteId">;

/**
 * Optional hook a domain example can use to simulate effects whose
 * guarantee.mode was REVALIDATE or UNKNOWN drifting by commit time, and to
 * simulate downstream (post-commit) effect finality transitions.
 */
export interface DriftSimulator {
  /** Called at commit time for one unit; may return a mutated copy of that unit's committedEffects. */
  onCommit?: (quote: MutationQuote, unit: CommittingUnit) => Effect[];
  /** Called at receipt time; may return effect receipts for the full commit result. */
  onReceipt?: (quote: MutationQuote, unitResults: UnitResult[]) => EffectReceipt[];
}

/**
 * Fault-injection hook used to exercise the INDETERMINATE path end-to-end,
 * now scoped per unit (a real multi-unit mutation attempt can have one
 * unit succeed while another times out downstream).
 *
 * `shouldTimeout` simulates a provider genuinely unable to tell, at commit
 * time, whether a given unit's mutation applied (e.g. its downstream
 * dispatch — a payment processor, a GDS, a ledger — never returned).
 *
 * `reconciliationOutcome` simulates what a later reconciliation/
 * authoritative-read attempt would discover for a given indeterminate unit.
 * Returning "APPLIED" or "REFUSED" simulates the provider learning the true
 * outcome (by reading actual state, not by replaying the mutation);
 * returning undefined (the default if unset) simulates the uncertainty
 * still not being resolvable. This is deliberately NOT hardcoded to always
 * resolve to APPLIED — a reconciliation path that only ever confirms
 * success would misrepresent what reconciliation actually is (see
 * /spec/normative-spec.md §4c).
 */
export interface FaultInjector {
  shouldTimeout?: (request: CommitRequest, quote: MutationQuote, unit: CommittingUnit) => boolean;
  reconciliationOutcome?: (
    quote: MutationQuote,
    unit: CommittingUnit
  ) => "APPLIED" | "REFUSED" | undefined;
}

let quoteCounter = 0;
function nextQuoteId(): string {
  quoteCounter += 1;
  return `quote_${quoteCounter}_${Date.now()}`;
}

let correlationCounter = 0;
function nextCorrelationId(): string {
  correlationCounter += 1;
  return `reconcile_${correlationCounter}_${Date.now()}`;
}

/** Internal bookkeeping for one indeterminate unit awaiting reconciliation. */
interface PendingReconciliation {
  quoteId: string;
  unitRef: string;
}

export class ReferenceProvider {
  private quotesById = new Map<string, MutationQuote>();
  private snapshotsByTarget = new Map<string, unknown>();
  /** Latest UnitResult[] per quoteId, so receipt() and reconciliation can see current state. */
  private unitResultsByQuoteId = new Map<string, UnitResult[]>();
  /** Pending indeterminate units, keyed by the Reconciliation.correlationId this provider issued. */
  private pendingByCorrelationId = new Map<string, PendingReconciliation>();

  constructor(
    private readonly quoter: Quoter,
    private readonly drift: DriftSimulator = {},
    private readonly fault: FaultInjector = {}
  ) {}

  /** Registers (or updates) the current snapshot reference for a target resource. */
  setSnapshot(target: unknown, snapshot: unknown): void {
    this.snapshotsByTarget.set(JSON.stringify(target), snapshot);
  }

  /** Step 1: Proposal -> Quote. */
  quote(proposal: MutationProposal): MutationQuote {
    const partial = this.quoter(proposal);
    const quote: MutationQuote = { ...partial, quoteId: nextQuoteId() };
    assertQuoteUnitsWellFormed(quote);
    this.quotesById.set(quote.quoteId, quote);
    return quote;
  }

  /**
   * Step 2: Quote -> Commit. Produces one UnitResult per CommittingUnit in
   * the quote (spec §1b complete-coverage requirement). Quote-level
   * failures (unknown quote, expired, snapshot mismatch) still short-circuit
   * to a uniform result across all units, since none of them ever reached
   * per-unit processing; constraint violations and timeouts, by contrast,
   * are evaluated and can differ per unit.
   */
  commit(request: CommitRequest, now: Date = new Date()): CommitResult {
    const quote = this.quotesById.get(request.quoteId);

    if (!quote) {
      // No quote to enumerate units from; nothing to report per-unit.
      // A provider cannot invent units it never quoted, so this remains a
      // single synthetic UnitResult keyed by a placeholder — see
      // /spec/normative-spec.md §1b note on unknown-quote handling.
      const unitResults: UnitResult[] = [
        { unitRef: "unknown", outcome: "REFUSED", refusalReason: "PROVIDER_REJECTED" },
      ];
      return { quoteId: request.quoteId, unitResults, aggregateHint: computeAggregateHint(unitResults) };
    }

    if (isQuoteExpired(quote, now)) {
      const unitResults: UnitResult[] = quote.units.map((u) => ({
        unitRef: u.unitRef,
        outcome: "REFUSED",
        refusalReason: "QUOTE_EXPIRED",
      }));
      return { quoteId: quote.quoteId, unitResults, aggregateHint: computeAggregateHint(unitResults) };
    }

    if (quote.commitConsistency === "SNAPSHOT_REQUIRED") {
      const current = this.snapshotsByTarget.get(JSON.stringify(quote.target));
      if (JSON.stringify(current) !== JSON.stringify(quote.snapshot)) {
        const unitResults: UnitResult[] = quote.units.map((u) => ({
          unitRef: u.unitRef,
          outcome: "REFUSED",
          refusalReason: "SNAPSHOT_MISMATCH",
        }));
        this.unitResultsByQuoteId.set(quote.quoteId, unitResults);
        return { quoteId: quote.quoteId, unitResults, aggregateHint: computeAggregateHint(unitResults) };
      }
    }

    const violated = evaluateAcceptanceConstraints(quote, request.acceptanceConstraints);
    const violatedEffectIds = new Set<string>();
    if (violated.length > 0) {
      for (const c of violated) violatedEffectIds.add(c.effectId);
    }

    const unitResults: UnitResult[] = quote.units.map((unit) => {
      // A unit is refused if any of its effects is named by a violated
      // constraint. A unit with no violated effects proceeds independently
      // of whether some OTHER unit's constraint was violated — this is
      // exactly the "independently committing" property being modeled.
      const unitViolated = unit.effects.some((e) => violatedEffectIds.has(e.effectId));
      if (unitViolated) {
        return { unitRef: unit.unitRef, outcome: "REFUSED", refusalReason: "CONSTRAINT_VIOLATED" };
      }

      // Fault injection: simulate a downstream timeout for this specific
      // unit. Other units in the same commit attempt are unaffected.
      if (this.fault.shouldTimeout?.(request, quote, unit)) {
        const correlationId = nextCorrelationId();
        this.pendingByCorrelationId.set(correlationId, { quoteId: quote.quoteId, unitRef: unit.unitRef });

        const hasReconciliationPath = this.fault.reconciliationOutcome !== undefined;
        const reconciliation: Reconciliation = hasReconciliationPath
          ? { mode: "MACHINE_RESOLVABLE", correlationId }
          : { mode: "NONE" };

        return { unitRef: unit.unitRef, outcome: "INDETERMINATE", reconciliation };
      }

      const committedEffects = this.drift.onCommit
        ? this.drift.onCommit(quote, unit)
        : unit.effects.map((e) => ({ ...e }));

      return { unitRef: unit.unitRef, outcome: "APPLIED", committedEffects };
    });

    this.unitResultsByQuoteId.set(quote.quoteId, unitResults);

    return { quoteId: quote.quoteId, unitResults, aggregateHint: computeAggregateHint(unitResults) };
  }

  /**
   * Reconciliation for a prior INDETERMINATE unit, keyed by the
   * correlationId its Reconciliation carried (spec §4b/§4c: this resolves
   * the prior attempt via a read/status-check, NOT by replaying the
   * mutation). Returns the outcome the provider can now actually confirm
   * (or 'STILL_INDETERMINATE' if it still cannot) — deliberately not
   * hardcoded to always succeed; see FaultInjector.reconciliationOutcome.
   *
   * On resolution, updates this provider's internal unitResultsByQuoteId
   * so a subsequent receipt() call reflects the resolved state.
   */
  reconcile(correlationId: string): "APPLIED" | "REFUSED" | "STILL_INDETERMINATE" {
    const pending = this.pendingByCorrelationId.get(correlationId);
    if (!pending) return "STILL_INDETERMINATE";

    const quote = this.quotesById.get(pending.quoteId);
    const unit = quote?.units.find((u) => u.unitRef === pending.unitRef);
    if (!quote || !unit) return "STILL_INDETERMINATE";

    // Ask the fault injector what reconciliation actually discovers — this
    // is a READ of the prior attempt's true state, not a new mutation
    // attempt. A real provider would look this up (e.g. query the
    // downstream ledger/GDS by the same correlation reference it gave the
    // caller), not resubmit the unit's change.
    const resolved = this.fault.reconciliationOutcome?.(quote, unit);
    if (resolved === undefined) {
      return "STILL_INDETERMINATE"; // genuinely not yet resolvable
    }

    const existingResults = this.unitResultsByQuoteId.get(quote.quoteId) ?? [];
    const updatedResults = existingResults.map((ur): UnitResult => {
      if (ur.unitRef !== unit.unitRef) return ur;
      if (resolved === "APPLIED") {
        const committedEffects = this.drift.onCommit
          ? this.drift.onCommit(quote, unit)
          : unit.effects.map((e) => ({ ...e }));
        return { unitRef: unit.unitRef, outcome: "APPLIED", committedEffects };
      }
      return { unitRef: unit.unitRef, outcome: "REFUSED", refusalReason: "PROVIDER_REJECTED" };
    });

    this.unitResultsByQuoteId.set(quote.quoteId, updatedResults);
    this.pendingByCorrelationId.delete(correlationId);

    return resolved;
  }

  /** Step 3: Commit -> Receipt. Reports finality across every APPLIED unit's committedEffects. */
  receipt(quoteId: string): Receipt {
    const quote = this.quotesById.get(quoteId);
    const unitResults = this.unitResultsByQuoteId.get(quoteId) ?? [];

    const effectReceipts: EffectReceipt[] =
      this.drift.onReceipt && quote
        ? this.drift.onReceipt(quote, unitResults)
        : unitResults.flatMap((ur) =>
            (ur.committedEffects ?? []).map(
              (e): EffectReceipt => ({
                effectId: e.effectId,
                unitRef: ur.unitRef,
                finality: "FINAL",
                value: e.value,
                settledAt: new Date().toISOString(),
              })
            )
          );

    // Fail-clear guarantee (spec §6a): every committed effect, across every
    // unit, MUST appear in the receipt, even one an onReceipt override
    // forgot. Enforced here so an omission can never leave this
    // implementation's own output non-conformant.
    const receiptedIds = new Set(effectReceipts.map((r) => r.effectId));
    for (const ur of unitResults) {
      for (const effect of ur.committedEffects ?? []) {
        if (!receiptedIds.has(effect.effectId)) {
          effectReceipts.push({ effectId: effect.effectId, unitRef: ur.unitRef, finality: "UNKNOWN" });
        }
      }
    }

    return { quoteId, effectReceipts };
  }
}
