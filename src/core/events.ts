import { EventEmitter } from 'node:events';

export type LibrarianEventType = 'decision.added' | 'decision.updated' | 'verdict' | 'comment';

export interface LibrarianEvent {
  type: LibrarianEventType;
  decisionId: string;
  projectName?: string;
  title?: string;
  status?: string;
  at: number;
}

/**
 * In-process fan-out to SSE clients and to waiting long-polls.
 *
 * Delivery here is a latency optimization only, never a source of truth: a
 * dropped SSE client or a disconnected poller loses nothing, because every
 * event it would have carried is already committed to SQLite and re-readable.
 */
export class EventBus extends EventEmitter {
  private readonly recent: LibrarianEvent[] = [];

  emitEvent(event: LibrarianEvent): void {
    this.recent.push(event);
    if (this.recent.length > 100) this.recent.shift();
    this.emit('event', event);
    this.emit(`decision:${event.decisionId}`, event);
  }

  /** Test/debug aid: what has been emitted recently. */
  recentEvents(): readonly LibrarianEvent[] {
    return this.recent;
  }

  onceForDecision(decisionId: string, listener: (e: LibrarianEvent) => void): () => void {
    const channel = `decision:${decisionId}`;
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }
}
