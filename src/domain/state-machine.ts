import type { DecisionStatus } from './types.js';

export class VerdictError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_transition' | 'reason_required' | 'not_authorized',
  ) {
    super(message);
    this.name = 'VerdictError';
  }
}

const ALLOWED: Record<DecisionStatus, DecisionStatus[]> = {
  pending: ['approved', 'rejected', 'changes_requested', 'superseded'],
  // changes_requested → changes_requested is legal: a reviewer sending a second
  // batch of feedback on a still-open review is re-affirming the verdict with a
  // new reason, not fighting the state machine. Each pass lands as its own
  // verdict event, so the audit trail keeps every round of feedback and
  // listeners (channel, waiters) are re-notified with the fresh reason.
  changes_requested: ['approved', 'rejected', 'pending', 'changes_requested', 'superseded'],
  // A rejected decision may return to pending: that is a revision answering the
  // red light, and it is the shape of the best decision records — rejected v1,
  // the reason, then an approved v2. The rejection stays in the history.
  rejected: ['pending', 'superseded'],
  approved: ['superseded'],
  superseded: [],
};

/**
 * Guards every verdict transition. A rejection without a reason is refused
 * here and again by a CHECK constraint in the schema: a red light that doesn't
 * say why is not a decision, it's a shrug.
 */
export function assertTransition(
  from: DecisionStatus,
  to: DecisionStatus,
  reason: string | null | undefined,
): void {
  if (!ALLOWED[from].includes(to)) {
    throw new VerdictError(
      `cannot move a decision from '${from}' to '${to}'`,
      'invalid_transition',
    );
  }
  // A supersession must name what replaced it, for the same reason a rejection
  // must say why: a record whose successor is unnamed is a dead end for the
  // next reader, and unresolvable once memory of the reconciliation is gone.
  if ((to === 'rejected' || to === 'changes_requested' || to === 'superseded') && !reason?.trim()) {
    throw new VerdictError(`a '${to}' verdict must carry a reason`, 'reason_required');
  }
}

export function canTransition(from: DecisionStatus, to: DecisionStatus): boolean {
  return ALLOWED[from].includes(to);
}
