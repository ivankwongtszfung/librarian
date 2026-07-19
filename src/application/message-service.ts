import type { DecisionStore, QueuedMessage } from '../domain/ports.js';
import type { ChannelRegistry } from './channel-registry.js';
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
    private readonly registry: ChannelRegistry,
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

  /**
   * @returns `queued` when the agent is working and the message deliberately
   * waits; `delivered` when it actually reached a session. Both false means it
   * **parked** — stored, but no session is bound to its project. The caller must
   * be able to tell those apart, or the UI ends up claiming "sent" to nobody.
   */
  post(
    body: string,
    context: Record<string, string> | null,
  ): { queued: boolean; delivered: boolean } {
    const msg = this.store.addMessage(body, context);
    if (this.agentIsWorking()) return { queued: true, delivered: false };
    return { queued: false, delivered: this.flush().includes(msg.id) };
  }

  /** @returns the ids actually delivered — empty when nothing had a home. */
  flush(): string[] {
    const pending = this.store.undeliveredMessages();
    if (!pending.length) return [];

    // Route by project (ADR-013): group by the target project so a batch never
    // mixes projects — each group is ONE turn to the sessions for that project.
    // The '' key is the global group (unprojected "this page" messages).
    const groups = new Map<string, QueuedMessage[]>();
    for (const m of pending) {
      const key = m.context?.project ?? '';
      const bucket = groups.get(key);
      if (bucket) bucket.push(m);
      else groups.set(key, [m]);
    }

    const delivered: string[] = [];
    for (const [key, msgs] of groups) {
      const projectName = key || undefined;
      // Never lost: a targeted message waits for a session in its project; a
      // global message waits for anyone to be listening. No home yet → it stays
      // a queued row and flushes when a matching session connects.
      const deliverable = projectName
        ? this.registry.hasProject(projectName)
        : this.registry.hasAny();
      if (!deliverable) continue;
      this.emitGroup(projectName, msgs);
      for (const m of msgs) delivered.push(m.id);
    }
    if (delivered.length) this.store.markMessagesDelivered(delivered);
    return delivered;
  }

  /** Emit one group as a single channel turn — plain for one, framed for many. */
  private emitGroup(projectName: string | undefined, msgs: QueuedMessage[]): void {
    if (msgs.length === 1) {
      const [m] = msgs;
      this.bus.emitEvent({
        type: 'message',
        decisionId: m.context?.decisionId ?? '',
        projectName,
        body: m.body,
        context: m.context ?? undefined,
        at: this.clock(),
      });
      return;
    }
    // One turn, everything in order, each entry labeled with where the human
    // was standing when they said it.
    const lines = msgs.map((m, i) => {
      const where = m.context?.page ? ` · ${m.context.page}` : '';
      const title = m.context?.title ? ` · "${m.context.title}"` : '';
      return `[${i + 1}/${msgs.length}${where}${title}] ${m.body}`;
    });
    this.bus.emitEvent({
      type: 'message',
      decisionId: '',
      projectName,
      body: lines.join('\n\n'),
      context: { batch: String(msgs.length), ...(projectName ? { project: projectName } : {}) },
      at: this.clock(),
    });
  }

  /** Undelivered messages grouped by the project session they're waiting for —
   *  the catchup surfaces this so a parked question reads as parked, not gone. */
  pendingByProject(): Array<{ project: string | null; count: number }> {
    const counts = new Map<string, number>();
    for (const m of this.store.undeliveredMessages()) {
      const key = m.context?.project ?? '';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].map(([k, count]) => ({ project: k || null, count }));
  }
}
