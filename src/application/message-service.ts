import type { DecisionStore } from '../domain/ports.js';
import type { EventBus } from './events.js';

/** How long a "working" report stays believable without a fresh heartbeat.
 *  A crashed session must never hold the queue hostage (ADR-011). */
export const PRESENCE_TTL_MS = 2 * 60_000;

export type PresenceState = 'working' | 'idle';

/**
 * Chat-bar delivery scheduling (ADR-011): messages are durable rows first;
 * while the agent is working they queue, and when it goes idle the whole
 * backlog flushes as ONE bus event — one interruption carrying everything
 * the human said, instead of an interruption per thought.
 *
 * Presence is best-effort, reported by Claude Code hooks. Unknown presence
 * (no hooks installed, TTL expired) means deliver immediately — exactly the
 * behavior before this service existed.
 */
export class MessageService {
  private state: PresenceState = 'idle';
  private reportedAt = 0;

  constructor(
    private readonly store: DecisionStore,
    private readonly bus: EventBus,
    private readonly clock: () => number = Date.now,
  ) {}

  agentIsWorking(): boolean {
    return this.state === 'working' && this.clock() - this.reportedAt < PRESENCE_TTL_MS;
  }

  reportPresence(state: PresenceState): void {
    this.state = state;
    this.reportedAt = this.clock();
    // Going idle is the flush signal: whatever the human said mid-turn is
    // delivered now, together.
    if (state === 'idle') this.flush();
  }

  /** @returns queued=true when the agent is working and the message waits. */
  post(body: string, context: Record<string, string> | null): { queued: boolean } {
    this.store.addMessage(body, context);
    if (this.agentIsWorking()) return { queued: true };
    this.flush();
    return { queued: false };
  }

  flush(): void {
    const pending = this.store.undeliveredMessages();
    if (!pending.length) return;

    if (pending.length === 1) {
      const [m] = pending;
      this.bus.emitEvent({
        type: 'message',
        decisionId: m.context?.decisionId ?? '',
        body: m.body,
        context: m.context ?? undefined,
        at: this.clock(),
      });
    } else {
      // One turn, everything in order, each entry labeled with where the
      // human was standing when they said it.
      const lines = pending.map((m, i) => {
        const where = m.context?.page ? ` · ${m.context.page}` : '';
        const title = m.context?.title ? ` · "${m.context.title}"` : '';
        return `[${i + 1}/${pending.length}${where}${title}] ${m.body}`;
      });
      this.bus.emitEvent({
        type: 'message',
        decisionId: '',
        body: lines.join('\n\n'),
        context: { batch: String(pending.length) },
        at: this.clock(),
      });
    }
    this.store.markMessagesDelivered(pending.map((m) => m.id));
  }
}
