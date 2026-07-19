/** A connected channel session and the projects it is bound to (ADR-016). */
export interface SessionInfo {
  /** Stable id the session presents on connect: `ses_<hex>`. */
  key: string;
  /** Where the session was launched — context for a human choosing a binding. */
  cwd: string | null;
  /** The projects this session handles. Seeded from its cwd guess, then
   *  authoritative once a human rebinds it. A session may hold several. */
  projects: string[];
  connectedAt: number;
}

/**
 * Which sessions are connected, and what each is working on (ADR-013 + ADR-016).
 *
 * Two concerns, and only the second needs bookkeeping:
 *  - Per-connection FILTERING needs no registry — each connection's listener
 *    drops what isn't its project.
 *  - The "never lost" DURABILITY guarantee needs to know whether a home exists,
 *    so an orphan message stays queued instead of being marked delivered into
 *    the void. That knowledge is here.
 *
 * ADR-016 changed *how a session gets its project*: it is a **binding this
 * registry holds**, not a string frozen at connect. `basename(cwd)` only seeds
 * the default — a human can rebind a live session, which is why the SSE filter
 * must look the projects up by key on every event rather than capture them once.
 */
export class ChannelRegistry {
  private readonly sessions = new Map<string, SessionInfo>();

  /** A session connected (or reconnected — same key replaces the entry). */
  register(
    key: string,
    info: { cwd?: string | null; projects: string[]; at?: number },
  ): SessionInfo {
    const session: SessionInfo = {
      key,
      cwd: info.cwd ?? null,
      projects: dedupe(info.projects),
      connectedAt: info.at ?? Date.now(),
    };
    this.sessions.set(key, session);
    return session;
  }

  /** A session disconnected. */
  unregister(key: string): void {
    this.sessions.delete(key);
  }

  /** Rebind a live session to different projects. Null when the key is unknown. */
  bind(key: string, projects: string[]): SessionInfo | null {
    const session = this.sessions.get(key);
    if (!session) return null;
    session.projects = dedupe(projects);
    return session;
  }

  /** The live binding — what the SSE filter consults per event, never a
   *  captured constant, so a rebind takes effect immediately. */
  projectsOf(key: string | undefined | null): string[] {
    if (!key) return [];
    return this.sessions.get(key)?.projects ?? [];
  }

  /** Is at least one connected session bound to this project? */
  hasProject(project: string): boolean {
    for (const s of this.sessions.values()) {
      if (s.projects.includes(project)) return true;
    }
    return false;
  }

  /** Is any session connected at all? (global, unprojected messages) */
  hasAny(): boolean {
    return this.sessions.size > 0;
  }

  /** Every live session — the sessions panel, and diagnostics. */
  list(): SessionInfo[] {
    return [...this.sessions.values()].sort((a, b) => a.connectedAt - b.connectedAt);
  }
}

function dedupe(projects: string[]): string[] {
  return [...new Set(projects.map((p) => p.trim()).filter(Boolean))];
}
