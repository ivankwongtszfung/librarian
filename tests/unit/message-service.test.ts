import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelRegistry } from '../../src/application/channel-registry.js';
import { EventBus } from '../../src/application/events.js';
import { MessageService, PRESENCE_TTL_MS } from '../../src/application/message-service.js';
import { withPresenceHooks, withoutPresenceHooks } from '../../src/infrastructure/service/hooks.js';
import { openDb } from '../../src/infrastructure/store/db.js';
import { Repository } from '../../src/infrastructure/store/repository.js';

// ADR-011: messages are durable rows; while the agent works they queue, and
// idle flushes the backlog as ONE event. Unknown presence = deliver now.
// ADR-013: a message is delivered only when a session for its project (or, for
// a global message, any session) is connected — else it stays a queued row.

describe('MessageService', () => {
  let repo: Repository;
  let bus: EventBus;
  let clockNow: number;
  let registry: ChannelRegistry;
  let svc: MessageService;

  beforeEach(() => {
    repo = new Repository(openDb(':memory:'));
    bus = new EventBus();
    clockNow = 1_000_000;
    // A session is listening, so global/unprojected messages have a home.
    registry = new ChannelRegistry();
    registry.register('ses_demo', { projects: ['demo'] });
    svc = new MessageService(repo, bus, registry, () => clockNow);
  });

  const messageEvents = () => bus.recentEvents().filter((e) => e.type === 'message');

  it('delivers immediately when presence is unknown', () => {
    const { queued } = svc.post('hello', { page: '/' });
    expect(queued).toBe(false);
    expect(messageEvents()).toHaveLength(1);
    expect(repo.undeliveredMessages()).toHaveLength(0);
  });

  it('queues while the agent is working — durable, no event', () => {
    svc.reportPresence('working');
    const { queued } = svc.post('wait for me', { page: '/' });
    expect(queued).toBe(true);
    expect(messageEvents()).toHaveLength(0);
    expect(repo.undeliveredMessages()).toHaveLength(1);
  });

  it('flushes the backlog as ONE batched event on idle', () => {
    svc.reportPresence('working');
    svc.post('first thought', { page: '/', view: 'catchup' });
    svc.post('second thought', { page: '/d/dec_1', title: 'ADR-X' });

    svc.reportPresence('idle');

    const events = messageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].context?.batch).toBe('2');
    // Each line carries its own id so the agent can answer them separately
    // (ADR-019); the id is generated, so match around it.
    expect(events[0].body).toMatch(/\[1\/2 · \/ · id=msg_\w+\] first thought/);
    expect(events[0].body).toMatch(/\[2\/2 · \/d\/dec_1 · "ADR-X" · id=msg_\w+\] second thought/);
    expect(events[0].messageIds).toHaveLength(2);
    expect(repo.undeliveredMessages()).toHaveLength(0);

    // A second idle report must not re-deliver.
    svc.reportPresence('idle');
    expect(messageEvents()).toHaveLength(1);
  });

  it('a single queued message flushes without batch framing', () => {
    svc.reportPresence('working');
    svc.post('just one', { page: '/' });
    svc.reportPresence('idle');
    const events = messageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].body).toBe('just one');
    expect(events[0].context?.batch).toBeUndefined();
  });

  it('a stale working report cannot hold the queue hostage (TTL)', () => {
    svc.reportPresence('working');
    clockNow += PRESENCE_TTL_MS + 1;
    const { queued } = svc.post('are you there?', null);
    expect(queued).toBe(false);
    expect(messageEvents()).toHaveLength(1);
  });

  // ---------- routing by project (ADR-013) ----------

  it('a message for a project with no connected session stays queued', () => {
    // presence is unknown (would deliver), but no "acct" session is listening.
    const { queued } = svc.post('about accounting', { project: 'acct', page: '/p/acct' });
    expect(queued).toBe(false); // not "agent working" — it simply has no home
    expect(messageEvents()).toHaveLength(0);
    expect(repo.undeliveredMessages()).toHaveLength(1);
    expect(svc.pendingByProject()).toEqual([{ project: 'acct', count: 1 }]);
  });

  it('delivers a parked message when its project session connects', () => {
    svc.post('about accounting', { project: 'acct', page: '/p/acct' });
    expect(messageEvents()).toHaveLength(0);

    registry.register('ses_acct', { projects: ['acct'] }); // the accounting_app channel connects…
    svc.flush(); // …which triggers a flush

    const events = messageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].projectName).toBe('acct');
    expect(events[0].body).toBe('about accounting');
    expect(repo.undeliveredMessages()).toHaveLength(0);
  });

  it('never mixes projects in one batch — one turn per project', () => {
    registry.register('ses_acct', { projects: ['acct'] });
    svc.reportPresence('working');
    svc.post('for demo', { project: 'demo', page: '/p/demo' });
    svc.post('for acct', { project: 'acct', page: '/p/acct' });
    svc.reportPresence('idle'); // flush

    const events = messageEvents();
    expect(events).toHaveLength(2);
    const byProject = new Map(events.map((e) => [e.projectName, e.body]));
    expect(byProject.get('demo')).toBe('for demo');
    expect(byProject.get('acct')).toBe('for acct');
  });

  it('batches multiple messages for the SAME project as one framed turn', () => {
    registry.register('ses_acct', { projects: ['acct'] });
    svc.reportPresence('working');
    svc.post('first', { project: 'acct', page: '/p/acct' });
    svc.post('second', { project: 'acct', page: '/p/acct' });
    svc.reportPresence('idle');

    const events = messageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].projectName).toBe('acct');
    expect(events[0].context?.batch).toBe('2');
    expect(events[0].context?.project).toBe('acct');
    expect(events[0].body).toMatch(/\[1\/2 · \/p\/acct · id=msg_\w+\] first/);
    expect(events[0].body).toMatch(/\[2\/2 · \/p\/acct · id=msg_\w+\] second/);
  });

  it('a targeted message never reaches another project', () => {
    // only "demo" is connected; a message for "acct" must not ride out.
    svc.post('secret for acct', { project: 'acct' });
    expect(messageEvents()).toHaveLength(0);
    expect(svc.pendingByProject()).toEqual([{ project: 'acct', count: 1 }]);
  });
});

describe('presence hooks settings merge', () => {
  const base = 'http://127.0.0.1:7801';

  it('adds both hooks and is idempotent', () => {
    const once = withPresenceHooks({}, base);
    expect(once.hooks?.UserPromptSubmit).toHaveLength(1);
    expect(once.hooks?.Stop).toHaveLength(1);
    expect(once.hooks?.Stop?.[0].hooks[0].command).toContain('"state":"idle"');
    const twice = withPresenceHooks(once, base);
    expect(twice.hooks?.UserPromptSubmit).toHaveLength(1);
  });

  it('never clobbers hooks it does not own', () => {
    const settings = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
      model: 'opus',
    };
    const withOurs = withPresenceHooks(settings, base);
    expect(withOurs.hooks?.Stop).toHaveLength(2);
    expect(withOurs.model).toBe('opus');

    const removed = withoutPresenceHooks(withOurs);
    expect(removed.hooks?.Stop).toHaveLength(1);
    expect(removed.hooks?.Stop?.[0].hooks[0].command).toBe('say done');
    expect(removed.hooks?.UserPromptSubmit).toBeUndefined();
  });
});
