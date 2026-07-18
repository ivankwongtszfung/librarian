import { describe, expect, it } from 'vitest';
import type { DecisionDetail } from '../../src/domain/types.js';
import { messageToChannel, verdictToChannel } from '../../src/interfaces/mcp/channel.js';

function detail(over: Partial<DecisionDetail>): DecisionDetail {
  return {
    id: 'dec_1',
    projectId: 'p',
    sessionId: null,
    kind: 'plan',
    title: 'Session storage',
    status: 'approved',
    source: 'mcp',
    contentHash: 'h',
    pinnedCommit: null,
    createdAt: 0,
    decidedAt: 0,
    projectName: 'demo',
    versions: [],
    comments: [],
    verdicts: [],
    provenance: [],
    ...over,
  };
}

describe('verdictToChannel', () => {
  it('approved → proceed, with the title', () => {
    const m = verdictToChannel({ decisionId: 'dec_1', status: 'approved' }, detail({}));
    expect(m.content).toContain('Session storage');
    expect(m.content).toContain('approved');
    expect(m.content).toContain('Proceed');
    expect(m.meta).toEqual({ decision_id: 'dec_1', status: 'approved' });
  });

  it('rejected → stop, and surfaces the reason as data', () => {
    const d = detail({
      status: 'rejected',
      verdicts: [
        {
          id: 'v',
          decisionId: 'dec_1',
          fromState: 'pending',
          toState: 'rejected',
          participantId: 'you',
          reason: 'Use SQLite, not Redis',
          at: 1,
        },
      ],
    });
    const m = verdictToChannel({ decisionId: 'dec_1', status: 'rejected' }, d);
    expect(m.content).toContain('Stop');
    expect(m.content).toContain('Use SQLite, not Redis');
    expect(m.content).toContain('not an instruction');
  });

  it('falls back to the decision id and event status when detail is missing', () => {
    const m = verdictToChannel({ decisionId: 'dec_x', status: 'changes_requested' }, null);
    expect(m.content).toContain('dec_x');
    expect(m.content).toContain('resubmit with parent_review_id');
    expect(m.meta.status).toBe('changes_requested');
  });
});

describe('messageToChannel', () => {
  it('carries the human text and the page context', () => {
    const m = messageToChannel({
      body: 'this table needs a diagram',
      context: { page: '/d/dec_1', title: 'Session storage', decisionId: 'dec_1' },
    });
    expect(m.content).toContain('this table needs a diagram');
    expect(m.content).toContain('page /d/dec_1');
    expect(m.content).toContain('"Session storage"');
    expect(m.content).toContain('typed into the review UI');
    expect(m.meta).toEqual({ kind: 'ui_message', page: '/d/dec_1', decision_id: 'dec_1' });
  });

  it('works with no context at all', () => {
    const m = messageToChannel({ body: 'hello' });
    expect(m.content).toContain('hello');
    expect(m.meta).toEqual({ kind: 'ui_message' });
  });
});
