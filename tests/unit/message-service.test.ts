import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/application/events.js';
import { MessageService, PRESENCE_TTL_MS } from '../../src/application/message-service.js';
import { withPresenceHooks, withoutPresenceHooks } from '../../src/infrastructure/service/hooks.js';
import { openDb } from '../../src/infrastructure/store/db.js';
import { Repository } from '../../src/infrastructure/store/repository.js';

// ADR-011: messages are durable rows; while the agent works they queue, and
// idle flushes the backlog as ONE event. Unknown presence = deliver now.

describe('MessageService', () => {
  let repo: Repository;
  let bus: EventBus;
  let clockNow: number;
  let svc: MessageService;

  beforeEach(() => {
    repo = new Repository(openDb(':memory:'));
    bus = new EventBus();
    clockNow = 1_000_000;
    svc = new MessageService(repo, bus, () => clockNow);
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
    expect(events[0].body).toContain('[1/2 · /] first thought');
    expect(events[0].body).toContain('[2/2 · /d/dec_1 · "ADR-X"] second thought');
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
