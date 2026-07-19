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

  it('carries a highlighted passage and the section it sits in', () => {
    const m = messageToChannel({
      body: 'this claim is too strong',
      context: {
        decisionId: 'dec_1',
        section: 'Consequences',
        quote: 'the daemon stays loopback-only',
      },
    });
    expect(m.content).toContain('section “Consequences”');
    expect(m.content).toContain('They highlighted this passage');
    expect(m.content).toContain('> the daemon stays loopback-only');
    expect(m.meta.section).toBe('Consequences');
  });

  it('hands a screenshot over as a path to Read, never inline', () => {
    const m = messageToChannel({
      body: 'the spacing here is off',
      context: { attachment: '/Users/x/.librarian/attachments/att_ab12.png' },
    });
    expect(m.content).toContain('/Users/x/.librarian/attachments/att_ab12.png');
    expect(m.content).toContain('Read tool');
    expect(m.meta.attachment).toBe('/Users/x/.librarian/attachments/att_ab12.png');
  });

  it('tells the agent to resubmit as a new version when it is about a decision', () => {
    const m = messageToChannel({ body: 'please add a diagram', context: { decisionId: 'dec_9' } });
    expect(m.content).toContain('parent_review_id="dec_9"');
    expect(m.content).toContain('new version');
  });

  it('omits the revise instruction when no decision is in play', () => {
    const m = messageToChannel({ body: 'just thinking out loud', context: { page: '/' } });
    expect(m.content).not.toContain('parent_review_id');
  });

  it('frames a flushed batch as one queued backlog', () => {
    const m = messageToChannel({
      body: '[1/2 · /] first\n\n[2/2 · /d/dec_1] second',
      context: { batch: '2' },
    });
    expect(m.content).toContain('2 messages from the human, queued');
    expect(m.content).toContain('[1/2 · /] first');
    expect(m.meta).toEqual({ kind: 'ui_message', batch: '2' });
  });
});
