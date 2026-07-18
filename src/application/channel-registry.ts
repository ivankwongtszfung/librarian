/**
 * Which projects have a live channel session connected right now (ADR-013).
 *
 * Two distinct concerns make routing work, and only one of them needs this:
 *  - Per-connection FILTERING lives in the SSE handler and needs no registry —
 *    each connection's own listener closure drops what isn't its project.
 *  - The "never lost" DURABILITY guarantee DOES need to know whether a matching
 *    session exists, so a targeted message with no home stays a queued row
 *    instead of being marked delivered into the void. That knowledge is here.
 *
 * A session is counted only when it declares its project — the
 * `x-librarian-project` header the channel server sets on the events stream.
 * Browser EventSource connections carry no such header and are never counted:
 * they are readers, not agents that act on a message.
 */
export class ChannelRegistry {
  private readonly counts = new Map<string, number>();

  /** A channel session for `project` connected. */
  add(project: string): void {
    this.counts.set(project, (this.counts.get(project) ?? 0) + 1);
  }

  /** A channel session for `project` disconnected. */
  remove(project: string): void {
    const next = (this.counts.get(project) ?? 0) - 1;
    if (next > 0) this.counts.set(project, next);
    else this.counts.delete(project);
  }

  /** Is at least one session for this project connected? */
  hasProject(project: string): boolean {
    return (this.counts.get(project) ?? 0) > 0;
  }

  /** Is any project-declaring session connected at all? (global messages) */
  hasAny(): boolean {
    return this.counts.size > 0;
  }

  /** Projects with a live session — a snapshot, for diagnostics and tests. */
  projects(): string[] {
    return [...this.counts.keys()];
  }
}
