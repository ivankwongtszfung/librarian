import { beforeEach, describe, expect, it } from 'vitest';
import { VerdictError } from '../../src/domain/state-machine.js';
import { openDb } from '../../src/infrastructure/store/db.js';
import { Repository } from '../../src/infrastructure/store/repository.js';
import { contentHash } from '../../src/util/ids.js';

function repo(): Repository {
  return new Repository(openDb(':memory:'));
}

describe('content hash', () => {
  it('is stable across incidental whitespace and case', () => {
    const a = contentHash('proj', 'Use SQLite', 'We will  use\nSQLite.');
    const b = contentHash('proj', 'use sqlite', 'We will use SQLite.');
    expect(a).toBe(b);
  });

  it('differs when the substance differs', () => {
    const a = contentHash('proj', 'Use SQLite', 'body');
    const b = contentHash('proj', 'Use Postgres', 'body');
    expect(a).not.toBe(b);
  });
});

describe('repository', () => {
  let r: Repository;
  beforeEach(() => {
    r = repo();
  });

  it('stores a submitted decision as pending', () => {
    const { decision, version } = r.submit({
      project: 'accounting_app',
      title: 'Pre-production security gate',
      body: '# Gate\nWe will require a security review.',
      kind: 'adr',
      source: 'mcp',
    });
    expect(decision.status).toBe('pending');
    expect(decision.source).toBe('mcp');
    expect(version.num).toBe(1);
  });

  it('merges duplicate content and records both provenances', () => {
    const input = {
      project: 'accounting_app',
      title: 'Same doc',
      body: 'identical body',
      kind: 'adr' as const,
    };
    const first = r.submit({ ...input, source: 'mcp' });
    const second = r.submit({ ...input, source: 'watcher' });

    expect(second.deduped).toBe(true);
    expect(second.decision.id).toBe(first.decision.id);
    expect(r.listDecisions()).toHaveLength(1);

    const detail = r.getDecisionDetail(first.decision.id)!;
    expect(detail.provenance.map((p) => p.source).sort()).toEqual(['mcp', 'watcher']);
  });

  it('refuses a rejection with no reason', () => {
    const { decision } = r.submit({
      project: 'p',
      title: 't',
      body: 'b',
      kind: 'plan',
      source: 'mcp',
    });
    const human = r.upsertParticipant('human', 'you');

    expect(() =>
      r.applyVerdict({ decisionId: decision.id, to: 'rejected', reason: '  ', participant: human }),
    ).toThrow(VerdictError);

    expect(r.listVerdicts(decision.id)).toHaveLength(0);
    expect(r.getDecision(decision.id)!.status).toBe('pending');
  });

  it('keeps the red-light history when a rejection is later revised into an approval', () => {
    const human = r.upsertParticipant('human', 'you');
    const first = r.submit({
      project: 'p',
      title: 'Microservices',
      body: 'split it up',
      kind: 'plan',
      source: 'mcp',
    });
    r.applyVerdict({
      decisionId: first.decision.id,
      to: 'rejected',
      reason: 'overkill for a single-user app',
      participant: human,
    });

    // The revision answers the red light on the same thread.
    const revised = r.submit({
      project: 'p',
      title: 'Microservices',
      body: 'keep one process, split modules instead',
      kind: 'plan',
      source: 'mcp',
      parentDecisionId: first.decision.id,
    });
    expect(revised.decision.id).toBe(first.decision.id);
    expect(revised.version.num).toBe(2);
    expect(revised.decision.status).toBe('pending');

    r.applyVerdict({ decisionId: first.decision.id, to: 'approved', participant: human });

    const detail = r.getDecisionDetail(first.decision.id)!;
    expect(detail.status).toBe('approved');
    expect(detail.versions).toHaveLength(2);

    // The rejection survives the revision: rejected → revised → approved is the
    // whole shape of a real decision record, and none of it may be overwritten.
    const states = detail.verdicts.map((v) => v.toState);
    expect(states).toEqual(['rejected', 'pending', 'approved']);
    expect(detail.verdicts[0].reason).toBe('overkill for a single-user app');
  });

  it('finds rejections by search, with the reason intact', () => {
    const human = r.upsertParticipant('human', 'you');
    const { decision } = r.submit({
      project: 'accounting_app',
      title: 'Split backend into microservices',
      body: 'Proposal to split the backend into microservices.',
      kind: 'plan',
      source: 'mcp',
    });
    r.applyVerdict({
      decisionId: decision.id,
      to: 'rejected',
      reason: 'overkill for single user',
      participant: human,
    });

    const hits = r.search('microservices');
    expect(hits).toHaveLength(1);
    expect(hits[0].status).toBe('rejected');
    expect(hits[0].reason).toBe('overkill for single user');
  });

  it('builds a constraints digest of both green and red lights', () => {
    const human = r.upsertParticipant('human', 'you');
    const ok = r.submit({
      project: 'app',
      title: 'Security gate',
      body: 'gate it',
      kind: 'adr',
      source: 'mcp',
    });
    r.applyVerdict({ decisionId: ok.decision.id, to: 'approved', participant: human });

    const no = r.submit({
      project: 'app',
      title: 'Microservices',
      body: 'split',
      kind: 'plan',
      source: 'mcp',
    });
    r.applyVerdict({
      decisionId: no.decision.id,
      to: 'rejected',
      reason: 'too complex',
      participant: human,
    });

    const digest = r.constraints('app');
    expect(digest.accepted.map((d) => d.title)).toEqual(['Security gate']);
    expect(digest.rejected).toEqual([
      expect.objectContaining({ title: 'Microservices', reason: 'too complex' }),
    ]);
  });

  it('scopes the constraints digest by topic', () => {
    const human = r.upsertParticipant('human', 'you');
    const charts = r.submit({
      project: 'app',
      title: 'Chart simplicity',
      body: 'charts stay simple',
      kind: 'adr',
      source: 'mcp',
    });
    r.applyVerdict({ decisionId: charts.decision.id, to: 'approved', participant: human });
    const auth = r.submit({
      project: 'app',
      title: 'Auth flow',
      body: 'oauth',
      kind: 'adr',
      source: 'mcp',
    });
    r.applyVerdict({ decisionId: auth.decision.id, to: 'approved', participant: human });

    expect(r.constraints('app', 'charts').accepted.map((d) => d.title)).toEqual([
      'Chart simplicity',
    ]);
  });

  it('survives punctuation in a search query', () => {
    r.submit({
      project: 'p',
      title: 'Use Redis?',
      body: 'maybe redis',
      kind: 'adr',
      source: 'mcp',
    });
    expect(() => r.search('redis? OR (')).not.toThrow();
    expect(r.search('redis')).toHaveLength(1);
  });
});

// ADR-008 regression suite: the watcher races submissions on the transcript
// and used to swallow them — a gated submit_for_review deduped into the
// watcher's self-approved row and inherited 'approved' no human ever gave.
describe('dedup vs review intent (ADR-008)', () => {
  let r: Repository;
  beforeEach(() => {
    r = repo();
  });

  const doc = {
    project: 'proj',
    title: 'ADR-9: use the mailbox',
    body: '# ADR-9\nUse the mailbox.',
    kind: 'adr' as const,
  };

  it('a gated submit reclaims an unbacked approved capture', () => {
    // The watcher captures the doc first and asserts approved with no verdict.
    r.submit({ ...doc, source: 'watcher', initialStatus: 'approved' });
    // The agent then submits the same content for review.
    const result = r.submit({ ...doc, source: 'mcp' });

    expect(result.deduped).toBe(true);
    expect(result.reclaimed).toBe(true);
    expect(result.decision.status).toBe('pending');
    const detail = r.getDecisionDetail(result.decision.id)!;
    // The reclaim is audited: one verdict event, approved -> pending.
    expect(detail.verdicts).toHaveLength(1);
    expect(detail.verdicts[0].fromState).toBe('approved');
    expect(detail.verdicts[0].toState).toBe('pending');
  });

  it('a gated submit never reclaims a human-approved decision', () => {
    const first = r.submit({ ...doc, source: 'mcp' });
    const human = r.upsertParticipant('human', 'ivan');
    r.applyVerdict({ decisionId: first.decision.id, to: 'approved', participant: human });

    const again = r.submit({ ...doc, source: 'mcp' });
    expect(again.deduped).toBe(true);
    expect(again.reclaimed).toBeUndefined();
    expect(again.decision.status).toBe('approved');
  });

  it('an ungated capture never reclaims anything', () => {
    r.submit({ ...doc, source: 'watcher', initialStatus: 'approved' });
    const capture = r.submit({ ...doc, source: 'watcher', initialStatus: 'approved' });
    expect(capture.deduped).toBe(true);
    expect(capture.reclaimed).toBeUndefined();
  });

  it('parent_review_id beats the content hash', () => {
    const original = r.submit({ ...doc, source: 'mcp' });
    const human = r.upsertParticipant('human', 'ivan');
    r.applyVerdict({
      decisionId: original.decision.id,
      to: 'changes_requested',
      reason: 'add a diagram',
      participant: human,
    });

    // The watcher captures the REVISED text before the agent can resubmit it.
    const revised = '# ADR-9 v2\nUse the mailbox, with a diagram.';
    const captured = r.submit({
      ...doc,
      body: revised,
      source: 'watcher',
      initialStatus: 'approved',
    });
    expect(captured.decision.id).not.toBe(original.decision.id);

    // The resubmission names its thread — it must land there, not in the capture.
    const resubmit = r.submit({
      ...doc,
      body: revised,
      source: 'mcp',
      parentDecisionId: original.decision.id,
    });
    expect(resubmit.deduped).toBe(false);
    expect(resubmit.decision.id).toBe(original.decision.id);
    expect(resubmit.version.num).toBe(2);
    expect(resubmit.decision.status).toBe('pending');
  });

  it('an identical resubmit to its own thread is a no-op', () => {
    const original = r.submit({ ...doc, source: 'mcp' });
    const again = r.submit({ ...doc, source: 'mcp', parentDecisionId: original.decision.id });
    expect(again.deduped).toBe(true);
    expect(again.decision.id).toBe(original.decision.id);
    expect(r.getDecisionDetail(original.decision.id)!.versions).toHaveLength(1);
  });
});

describe('bug reports (kind: bug)', () => {
  it('a bug report submits, reviews, and searches like any decision', () => {
    const r = repoFactoryForBug();
    const result = r.submit({
      project: 'librarian',
      title: 'BUG-1: something is silently wrong',
      body: '# BUG-1\nSymptom: ...',
      kind: 'bug',
      source: 'mcp',
    });
    expect(result.decision.kind).toBe('bug');
    expect(result.decision.status).toBe('pending');
    expect(r.search('silently wrong')[0]?.kind).toBe('bug');
  });
});

function repoFactoryForBug(): Repository {
  return new Repository(openDb(':memory:'));
}
