import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/application/events.js';
import { ReviewService } from '../../src/application/review-service.js';
import { MemoryNotifier } from '../../src/infrastructure/notify/notifier.js';
import { openDb } from '../../src/infrastructure/store/db.js';
import { Repository } from '../../src/infrastructure/store/repository.js';

// Regression suite for the double-comment bug: the reviewer's second
// "request changes" on a still-open review used to throw invalid_transition
// AFTER the comment row had committed — the UI reported failure for a write
// that succeeded, the reviewer retyped it, and the thread duplicated.

describe('ReviewService.postComments', () => {
  let repo: Repository;
  let bus: EventBus;
  let service: ReviewService;
  let decisionId: string;

  beforeEach(async () => {
    repo = new Repository(openDb(':memory:'));
    bus = new EventBus();
    service = new ReviewService(repo, bus, new MemoryNotifier());
    const { reviewId } = await service.submitForReview({
      project: 'proj',
      title: 'Use SQLite',
      doc: '# Plan\nUse SQLite.',
    });
    decisionId = reviewId;
  });

  it('accepts a second request-changes review on a still-open review', () => {
    service.postComments({
      decisionId,
      comments: [{ body: 'please shorten this' }],
      requestChanges: true,
    });
    // The review is now changes_requested. A second batch of feedback must be
    // accepted, not blocked — this exact call used to throw.
    const second = service.postComments({
      decisionId,
      comments: [{ body: 'and add a diagram' }],
      requestChanges: true,
    });
    expect(second.added).toBe(1);

    const detail = repo.getDecisionDetail(decisionId)!;
    expect(detail.status).toBe('changes_requested');
    expect(detail.comments.map((c) => c.body)).toEqual([
      'please shorten this',
      'and add a diagram',
    ]);
    // Each pass is its own verdict event, so the audit keeps every round and
    // listeners are re-notified with the fresh reason.
    const changeEvents = detail.verdicts.filter((v) => v.toState === 'changes_requested');
    expect(changeEvents).toHaveLength(2);
    expect(changeEvents[1].reason).toBe('and add a diagram');
  });

  it('re-notifies listeners on the second review', () => {
    service.postComments({
      decisionId,
      comments: [{ body: 'first pass' }],
      requestChanges: true,
    });
    const before = bus.recentEvents().filter((e) => e.type === 'verdict').length;
    service.postComments({
      decisionId,
      comments: [{ body: 'second pass' }],
      requestChanges: true,
    });
    const after = bus.recentEvents().filter((e) => e.type === 'verdict').length;
    expect(after).toBe(before + 1);
  });

  it('stores NOTHING when the requested transition is invalid', () => {
    service.postVerdict({ decisionId, to: 'approved' });
    // approved → changes_requested is not a legal move; the whole operation
    // must be refused before the first write, or the error reply lies.
    expect(() =>
      service.postComments({
        decisionId,
        comments: [{ body: 'too late' }],
        requestChanges: true,
      }),
    ).toThrow();
    expect(repo.getDecisionDetail(decisionId)!.comments).toHaveLength(0);
  });

  it('plain comments (no request-changes) still land on a decided review', () => {
    service.postVerdict({ decisionId, to: 'approved' });
    const res = service.postComments({
      decisionId,
      comments: [{ body: 'for the record' }],
    });
    expect(res.added).toBe(1);
  });
});
