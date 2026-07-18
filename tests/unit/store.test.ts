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
