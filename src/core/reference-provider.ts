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

let quoteCounter = 0;
function nextQuoteId(): string {
  quoteCounter += 1;
  return `quote_${quoteCounter}_${Date.now()}`;
}

export class ReferenceProvider {
  private quotesById = new Map<string, MutationQuote>();
  private snapshotsByTarget = new Map<string, unknown>();
  private committedByQuoteId = new Map<string, Effect[]>();

  constructor(
    private readonly quoter: Quoter,
    private readonly drift: DriftSimulator = {}
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

    const anyUnknownRelied = quote.effects.some((e) => e.guarantee.mode === "UNKNOWN");
    if (anyUnknownRelied && request.acceptanceConstraints.length > 0) {
      // Reference policy only: providers are free to commit UNKNOWN effects
      // when no constraint depends on them. This branch is unreachable given
      // evaluateAcceptanceConstraints already fails closed on UNKNOWN, and is
      // kept only as an explicit documentation point, not dead-code debt.
    }

    const committedEffects = this.drift.onCommit
      ? this.drift.onCommit(quote)
      : quote.effects.map((e) => ({ ...e }));

    this.committedByQuoteId.set(quote.quoteId, committedEffects);

    return { quoteId: quote.quoteId, outcome: "APPLIED", committedEffects };
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

    return { quoteId, mutationOutcome, effectReceipts };
  }
}
