/**
 * Mutation Safety Envelope (MSE) — reference provider, v0.1.0.
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
 */

import type {
  CommitRequest,
  CommitResult,
  Effect,
  MutationProposal,
  MutationQuote,
  Receipt,
  EffectReceipt,
} from "./types";
import { evaluateAcceptanceConstraints, isQuoteExpired } from "./validate";

export type Quoter = (proposal: MutationProposal) => Omit<MutationQuote, "quoteId">;

/**
 * Optional hook a domain example can use to simulate effects whose
 * guarantee.mode was REVALIDATE or UNKNOWN drifting by commit time, and to
 * simulate downstream (post-commit) effect finality transitions.
 */
export interface DriftSimulator {
  /** Called at commit time; may return a mutated copy of committedEffects. */
  onCommit?: (quote: MutationQuote) => Effect[];
  /** Called at receipt time; may return effect receipts. */
  onReceipt?: (quote: MutationQuote, committedEffects: Effect[]) => EffectReceipt[];
}

/**
 * Fault-injection hook used to exercise the INDETERMINATE path end-to-end.
 * A real provider becomes INDETERMINATE when it cannot safely tell whether
 * a commit it dispatched to some downstream system (a payment processor, a
 * GDS, a ledger) actually applied — e.g. the connection was lost after the
 * request was sent but before a response arrived. This hook simulates that:
 * when `shouldTimeout` returns true for a given commit attempt, `commit()`
 * behaves as though the request reached an unknown state, WITHOUT ever
 * knowing itself whether the downstream mutation applied. This mirrors a
 * real timeout: the provider genuinely cannot resolve it locally.
 */
export interface FaultInjector {
  shouldTimeout?: (request: CommitRequest, quote: MutationQuote) => boolean;
}

let quoteCounter = 0;
function nextQuoteId(): string {
  quoteCounter += 1;
  return `quote_${quoteCounter}_${Date.now()}`;
}

export class ReferenceProvider {
  private quotesById = new Map<string, MutationQuote>();
  private snapshotsByTarget = new Map<string, unknown>();
  private committedByQuoteId = new Map<string, Effect[]>();
  /** Commit requests whose outcome resolved to INDETERMINATE, keyed by idempotencyKey. */
  private indeterminateByIdempotencyKey = new Map<string, CommitRequest>();

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
    this.quotesById.set(quote.quoteId, quote);
    return quote;
  }

  /** Step 2: Quote -> Commit. */
  commit(request: CommitRequest, now: Date = new Date()): CommitResult {
    const quote = this.quotesById.get(request.quoteId);

    if (!quote) {
      return {
        quoteId: request.quoteId,
        outcome: "REFUSED",
        refusalReason: "PROVIDER_REJECTED",
      };
    }

    if (isQuoteExpired(quote, now)) {
      return { quoteId: quote.quoteId, outcome: "REFUSED", refusalReason: "QUOTE_EXPIRED" };
    }

    if (quote.commitConsistency === "SNAPSHOT_REQUIRED") {
      const current = this.snapshotsByTarget.get(JSON.stringify(quote.target));
      if (JSON.stringify(current) !== JSON.stringify(quote.snapshot)) {
        return {
          quoteId: quote.quoteId,
          outcome: "REFUSED",
          refusalReason: "SNAPSHOT_MISMATCH",
        };
      }
    }

    const violated = evaluateAcceptanceConstraints(quote, request.acceptanceConstraints);
    if (violated.length > 0) {
      return {
        quoteId: quote.quoteId,
        outcome: "REFUSED",
        refusalReason: "CONSTRAINT_VIOLATED",
      };
    }

    // Fault injection: simulate a downstream timeout where this provider
    // genuinely cannot determine, at the time it must respond, whether the
    // mutation applied. This is what a real INDETERMINATE looks like — it
    // is not a code path the provider "chooses" so much as one forced on it
    // by an external system's silence.
    if (this.fault.shouldTimeout?.(request, quote)) {
      if (request.idempotencyKey) {
        this.indeterminateByIdempotencyKey.set(request.idempotencyKey, request);
      }
      return { quoteId: quote.quoteId, outcome: "INDETERMINATE" };
    }

    const committedEffects = this.drift.onCommit
      ? this.drift.onCommit(quote)
      : quote.effects.map((e) => ({ ...e }));

    this.committedByQuoteId.set(quote.quoteId, committedEffects);

    return { quoteId: quote.quoteId, outcome: "APPLIED", committedEffects };
  }

  /**
   * Reconciliation for a prior INDETERMINATE commit, keyed by the same
   * idempotencyKey the original CommitRequest carried. Returns the outcome
   * the provider can now actually confirm (or 'STILL_INDETERMINATE' if it
   * still cannot), rather than performing a naive blind resend of commit().
   * This exists to demonstrate the spec's requirement (§3.2, and
   * /docs/security-considerations.md §3) that a caller must not treat
   * INDETERMINATE as safely retryable via a plain repeated commit() call.
   */
  reconcileIndeterminateCommit(
    idempotencyKey: string
  ): "APPLIED" | "REFUSED" | "STILL_INDETERMINATE" {
    const pending = this.indeterminateByIdempotencyKey.get(idempotencyKey);
    if (!pending) return "STILL_INDETERMINATE";

    // In this reference implementation, reconciliation resolves the same
    // request deterministically once "checked" (simulating, e.g., polling
    // the downstream system's actual ledger state) rather than resubmitting
    // it as a new commit — a real provider would look up what actually
    // happened, not attempt the mutation again.
    const quote = this.quotesById.get(pending.quoteId);
    if (!quote) return "REFUSED";

    const committedEffects = this.drift.onCommit
      ? this.drift.onCommit(quote)
      : quote.effects.map((e) => ({ ...e }));

    this.committedByQuoteId.set(quote.quoteId, committedEffects);
    this.indeterminateByIdempotencyKey.delete(idempotencyKey);

    return "APPLIED";
  }

  /** Step 3: Commit -> Receipt. */
  receipt(quoteId: string, mutationOutcome: CommitResult["outcome"]): Receipt {
    const quote = this.quotesById.get(quoteId);
    const committedEffects = this.committedByQuoteId.get(quoteId) ?? [];

    const effectReceipts: EffectReceipt[] =
      this.drift.onReceipt && quote
        ? this.drift.onReceipt(quote, committedEffects)
        : committedEffects.map((e) => ({
            effectType: e.type,
            finality: mutationOutcome === "APPLIED" ? "FINAL" : "UNKNOWN",
            value: e.value,
            settledAt: mutationOutcome === "APPLIED" ? new Date().toISOString() : undefined,
          }));

    // Fail-clear guarantee (spec §7): every committed effect MUST appear in
    // the receipt, even one an onReceipt override forgot. Rather than only
    // asserting this in tests, the reference provider enforces it here so
    // an omission can never leave this implementation's own output non-
    // conformant.
    const receiptedTypes = new Set(effectReceipts.map((r) => r.effectType));
    for (const effect of committedEffects) {
      if (!receiptedTypes.has(effect.type)) {
        effectReceipts.push({ effectType: effect.type, finality: "UNKNOWN" });
      }
    }

    return { quoteId, mutationOutcome, effectReceipts };
  }
}
