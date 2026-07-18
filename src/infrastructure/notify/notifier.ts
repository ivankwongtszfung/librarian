import type { Notifier } from '../../domain/ports.js';
import type { Notification } from '../../domain/types.js';

/** Used when no ntfy topic is configured, and by the test suite. */
export class MemoryNotifier implements Notifier {
  private readonly log: Notification[] = [];

  async publish(n: Notification): Promise<void> {
    this.log.push(n);
  }

  sent(): readonly Notification[] {
    return this.log;
  }
}

export class NtfyNotifier implements Notifier {
  private readonly log: Notification[] = [];

  constructor(
    private readonly topicUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async publish(n: Notification): Promise<void> {
    this.log.push(n);
    try {
      await this.fetchImpl(this.topicUrl, {
        method: 'POST',
        body: n.body,
        headers: {
          Title: n.title,
          ...(n.url ? { Click: n.url } : {}),
          Tags: 'books',
        },
      });
    } catch {
      // A missed push costs a notification, not a decision — the pending review
      // is in the store either way. Never let the notifier break ingestion.
    }
  }

  sent(): readonly Notification[] {
    return this.log;
  }
}
