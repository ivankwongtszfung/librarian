import type { DecisionStore, Notifier } from '../domain/ports.js';
import { VerdictError, assertTransition } from '../domain/state-machine.js';
import { isResolved } from '../domain/types.js';
import type {
  DecisionKind,
  DecisionStatus,
  ParticipantType,
  ReviewOutcome,
} from '../domain/types.js';
import { unifiedDiff } from '../util/diff.js';
import type { EventBus } from './events.js';

export const MAX_WAIT_SECONDS = 50;

export interface SubmitForReviewInput {
  project: string;
  title: string;
  doc: string;
  kind?: DecisionKind;
  parentReviewId?: string;
  contextRefs?: string[];
  agent?: string;
  sessionRef?: string;
}

/**
 * The review loop. Everything a client or an agent can do to a decision passes
 * through here, so the store, the event bus, and the notifier can never drift
 * out of step with one another.
 */
export class ReviewService {
  constructor(
    private readonly repo: DecisionStore,
    private readonly bus: EventBus,
    private readonly notifier: Notifier,
    private readonly baseUrl = 'http://127.0.0.1:7801',
  ) {}

  async submitForReview(
    input: SubmitForReviewInput,
  ): Promise<{ reviewId: string; version: number; deduped: boolean }> {
    const result = this.repo.submit({
      project: input.project,
      title: input.title,
      body: input.doc,
      kind: input.kind ?? 'plan',
      source: 'mcp',
      agent: input.agent,
      sessionRef: input.sessionRef,
      parentDecisionId: input.parentReviewId,
      contextRefs: input.contextRefs,
    });

    // A revision reopens the same decision rather than minting a second one:
    // the thread, not the document, is the unit of review.
    if (!result.deduped) {
      this.bus.emitEvent({
        type: 'decision.added',
        decisionId: result.decision.id,
        projectName: input.project,
        title: input.title,
        status: result.decision.status,
        at: Date.now(),
      });

      await this.notifier.publish({
        title: `Pending review: ${input.title}`,
        body: `${input.project} · ${input.kind ?? 'plan'} · awaiting your verdict`,
        decisionId: result.decision.id,
        url: `${this.baseUrl}/d/${result.decision.id}`,
      });
    }

    return { reviewId: result.decision.id, version: result.version.num, deduped: result.deduped };
  }

  /** FYI tier: recorded, never gated, never pushed. */
  recordDecision(input: SubmitForReviewInput & { status?: DecisionStatus }): {
    decisionId: string;
  } {
    const result = this.repo.submit({
      project: input.project,
      title: input.title,
      body: input.doc,
      kind: input.kind ?? 'adr',
      source: 'mcp',
      agent: input.agent,
      sessionRef: input.sessionRef,
      initialStatus: input.status ?? 'approved',
    });

    if (!result.deduped) {
      this.bus.emitEvent({
        type: 'decision.added',
        decisionId: result.decision.id,
        projectName: input.project,
        title: input.title,
        status: result.decision.status,
        at: Date.now(),
      });
    }
    return { decisionId: result.decision.id };
  }

  /**
   * Server-side long-poll. Holds the request until the verdict lands or the
   * wait expires, then returns whatever the store says.
   *
   * The hold is an optimization, never the delivery mechanism: the outcome is
   * reconstructed from committed rows on every call, so a dropped connection,
   * a repeated poll, or a daemon restart all yield the same answer. Losing the
   * connection costs latency, never a verdict.
   */
  async getReview(
    reviewId: string,
    waitSeconds = 0,
    signal?: AbortSignal,
  ): Promise<ReviewOutcome | { error: 'not_found' }> {
    const outcome = this.repo.reviewOutcome(reviewId);
    if (!outcome) return { error: 'not_found' };
    if (isResolved(outcome.status) || waitSeconds <= 0) {
      if (isResolved(outcome.status)) this.repo.markCommentsDelivered(reviewId);
      return outcome;
    }

    const wait = Math.min(waitSeconds, MAX_WAIT_SECONDS) * 1000;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', finish);
        resolve();
      };

      const timer = setTimeout(finish, wait);
      // A hold in progress must not keep the process alive on shutdown.
      timer.unref?.();
      const unsubscribe = this.bus.onceForDecision(reviewId, (event) => {
        if (event.type === 'verdict') finish();
      });
      signal?.addEventListener('abort', finish, { once: true });
    });

    // An aborted hold means the caller is gone and the result is discarded —
    // and during shutdown the store may already be closed. Don't touch it.
    if (signal?.aborted) return outcome;

    const settledOutcome = this.repo.reviewOutcome(reviewId)!;
    if (isResolved(settledOutcome.status)) this.repo.markCommentsDelivered(reviewId);
    return settledOutcome;
  }

  postVerdict(input: {
    decisionId: string;
    to: DecisionStatus;
    reason?: string | null;
    by?: string;
  }): { ok: true } {
    const participant = this.repo.upsertParticipant('human', input.by ?? 'you');
    const event = this.repo.applyVerdict({
      decisionId: input.decisionId,
      to: input.to,
      reason: input.reason,
      participant,
    });

    this.bus.emitEvent({
      type: 'verdict',
      decisionId: input.decisionId,
      status: event.toState,
      at: event.at,
    });
    return { ok: true };
  }

  /**
   * Add to a decision's conversation.
   *
   * The thread is multi-party on purpose — the decision, not the chat, is the
   * unit of work, and its comments (human, agent, or role-scoped reviewer) are
   * what make it a rationale rather than a verdict slip. But commenting and
   * deciding are different powers: `requestChanges` is a verdict transition,
   * so only a human may pass it. Callers on the agent path must not.
   */
  postComments(input: {
    decisionId: string;
    comments: Array<{ body: string; anchorQuote?: string | null; versionNum?: number }>;
    by?: string;
    /** Who is speaking. Defaults to the human — the web UI and REST clients. */
    authorType?: ParticipantType;
    requestChanges?: boolean;
    reason?: string;
  }): { added: number } {
    const authorType = input.authorType ?? 'human';
    if (input.requestChanges && authorType !== 'human') {
      // Verdict authority is the human's alone. A non-human caller asking for
      // changes is trying to decide, not to comment.
      throw new VerdictError('only a human may transition a verdict', 'not_authorized');
    }

    // Validate the WHOLE operation before the first write. The comment insert
    // and the verdict transition commit in separate store transactions, so a
    // transition rejected after addComments would leave the comment stored
    // while the response reports failure — the reviewer retypes it and the
    // thread duplicates. An error reply must mean nothing was written.
    const reason = input.reason ?? summarize(input.comments);
    if (input.requestChanges) {
      const outcome = this.repo.reviewOutcome(input.decisionId);
      if (!outcome) throw new Error(`no such decision: ${input.decisionId}`);
      assertTransition(outcome.status, 'changes_requested', reason);
    }

    const participant = this.repo.upsertParticipant(authorType, input.by ?? 'you');
    const added = this.repo.addComments(input.decisionId, participant, input.comments);

    this.bus.emitEvent({
      type: 'comment',
      decisionId: input.decisionId,
      at: Date.now(),
    });

    // Submitting a review with comments is what moves the decision: the agent
    // wakes on the state change and reads the whole batch at once, rather than
    // reacting to each comment as it is typed.
    if (input.requestChanges) {
      this.postVerdict({
        decisionId: input.decisionId,
        to: 'changes_requested',
        reason,
        by: input.by,
      });
    }

    return { added: added.length };
  }

  diff(decisionId: string, from: number, to: number): string | null {
    const a = this.repo.getVersion(decisionId, from);
    const b = this.repo.getVersion(decisionId, to);
    if (!a || !b) return null;
    return unifiedDiff(a.bodyMd, b.bodyMd, `v${from}`, `v${to}`);
  }
}

function summarize(comments: Array<{ body: string }>): string {
  const first = comments[0]?.body ?? 'changes requested';
  return comments.length > 1 ? `${first} (+${comments.length - 1} more)` : first;
}
