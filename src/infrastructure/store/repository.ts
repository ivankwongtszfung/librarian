import type {
  DecisionStore,
  MessageHistoryItem,
  MessageReaction,
  QueuedMessage,
} from '../../domain/ports.js';
import { assertTransition } from '../../domain/state-machine.js';
import type {
  Catchup,
  CatchupItem,
  Comment,
  Decision,
  DecisionDetail,
  DecisionKind,
  DecisionStatus,
  Participant,
  ParticipantType,
  Project,
  ProjectCatchup,
  ReviewOutcome,
  SearchFilters,
  SearchHit,
  Session,
  Source,
  SubmitInput,
  SubmitResult,
  VerdictEvent,
  Version,
} from '../../domain/types.js';
import { contentHash, newId, now } from '../../util/ids.js';
import type { Db } from './db.js';

interface CatchupRow {
  id: string;
  project_id: string;
  body_md: string;
  generated_by: string | null;
  created_at: number;
}

interface DecisionRow {
  id: string;
  project_id: string;
  session_id: string | null;
  kind: DecisionKind;
  title: string;
  status: DecisionStatus;
  source: Source;
  content_hash: string;
  pinned_commit: string | null;
  created_at: number;
  decided_at: number | null;
}

// SubmitInput / SubmitResult moved to domain/types.ts so the DecisionStore port
// can reference them without the domain depending on this store.

export class Repository implements DecisionStore {
  constructor(private readonly db: Db) {}

  // ---------- projects, sessions, participants ----------

  upsertProject(name: string, rootPath?: string): Project {
    const existing = this.db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as
      | { id: string; name: string; root_path: string | null; created_at: number }
      | undefined;
    if (existing) {
      if (rootPath && !existing.root_path) {
        this.db
          .prepare('UPDATE projects SET root_path = ? WHERE id = ?')
          .run(rootPath, existing.id);
      }
      return {
        id: existing.id,
        name: existing.name,
        rootPath: rootPath ?? existing.root_path,
        createdAt: existing.created_at,
      };
    }
    const project: Project = {
      id: newId('prj'),
      name,
      rootPath: rootPath ?? null,
      createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)')
      .run(project.id, project.name, project.rootPath, project.createdAt);
    return project;
  }

  upsertSession(projectId: string, agent: string | null, externalRef: string | null): Session {
    if (externalRef) {
      const existing = this.db
        .prepare('SELECT * FROM sessions WHERE external_ref = ?')
        .get(externalRef) as
        | {
            id: string;
            project_id: string;
            agent: string | null;
            external_ref: string;
            started_at: number;
          }
        | undefined;
      if (existing) {
        return {
          id: existing.id,
          projectId: existing.project_id,
          agent: existing.agent,
          externalRef: existing.external_ref,
          startedAt: existing.started_at,
        };
      }
    }
    const session: Session = {
      id: newId('ses'),
      projectId,
      agent,
      externalRef,
      startedAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO sessions (id, project_id, agent, external_ref, started_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(session.id, session.projectId, session.agent, session.externalRef, session.startedAt);
    return session;
  }

  upsertParticipant(type: ParticipantType, name: string): Participant {
    const existing = this.db
      .prepare('SELECT * FROM participants WHERE type = ? AND name = ?')
      .get(type, name) as Participant | undefined;
    if (existing) return existing;
    const participant: Participant = { id: newId('par'), type, name };
    this.db
      .prepare('INSERT INTO participants (id, type, name) VALUES (?, ?, ?)')
      .run(participant.id, participant.type, participant.name);
    return participant;
  }

  // ---------- submission ----------

  /**
   * Creates a decision, or merges into an existing one when the same content
   * arrives twice (an agent submitted it and the watcher later observed the
   * same plan in a transcript). Both origins are kept: provenance is additive.
   */
  submit(input: SubmitInput): SubmitResult {
    const hash = contentHash(input.project, input.title, input.body);
    const tx = this.db.transaction((): SubmitResult => {
      const project = this.upsertProject(input.project);
      const session = input.sessionRef
        ? this.upsertSession(project.id, input.agent ?? null, input.sessionRef)
        : null;

      // A revision is a new version of the same decision, not a new decision:
      // the thread — doc, comments, verdicts, and the red light that prompted
      // the rewrite — is the unit of review, and it has to stay whole. The
      // thread also beats the content hash: the watcher races submissions on
      // the transcript, and if dedup ran first, its capture of this same text
      // would swallow the revision (ADR-008).
      if (input.parentDecisionId) {
        const parent = this.getDecision(input.parentDecisionId);
        if (parent) {
          if (parent.contentHash === hash) {
            // Identical resubmit: nothing new to review.
            this.recordProvenance(parent.id, input.source, input.sessionRef ?? null);
            return { decision: parent, version: this.latestVersion(parent.id)!, deduped: true };
          }
          const parentVersion = this.latestVersion(parent.id);
          const version = this.addVersion(
            parent.id,
            input.body,
            parentVersion?.id ?? null,
            input.contextRefs ?? null,
          );

          // The new version has not been ruled on yet, so the decision goes
          // back to pending — without erasing the verdict history that got here.
          if (parent.status !== 'pending') {
            this.applyVerdict({
              decisionId: parent.id,
              to: 'pending',
              reason: `revised to v${version.num}`,
              participant: this.upsertParticipant('agent', input.agent ?? 'agent'),
            });
          }

          // Dedupe should track the current body, not the one that was
          // rejected — unless another decision already holds this hash (a
          // watcher capture of the same text). The thread still wins; a stale
          // hash is the lesser harm.
          const holder = this.db
            .prepare('SELECT id FROM decisions WHERE content_hash = ?')
            .get(hash) as { id: string } | undefined;
          if (!holder) {
            this.db
              .prepare('UPDATE decisions SET content_hash = ? WHERE id = ?')
              .run(hash, parent.id);
          }
          this.recordProvenance(parent.id, input.source, input.sessionRef ?? null);
          this.syncFts(parent.id);

          return { decision: this.getDecision(parent.id)!, version, deduped: false };
        }
      }

      const existing = this.db
        .prepare('SELECT * FROM decisions WHERE content_hash = ?')
        .get(hash) as DecisionRow | undefined;

      if (existing) {
        this.recordProvenance(existing.id, input.source, input.sessionRef ?? null);
        const version = this.latestVersion(existing.id)!;
        const decision = this.rowToDecision(existing);

        // A gated submission claims a human review is owed. If the matching
        // row's status was never backed by a verdict event (the watcher
        // asserts 'approved' with none — ADR-008), the claim wins: reclaim
        // the row for review instead of silently inheriting the status.
        const gated = !input.initialStatus;
        const open = decision.status === 'pending' || decision.status === 'changes_requested';
        if (gated && !open) {
          const backed =
            (
              this.db
                .prepare('SELECT COUNT(*) AS n FROM verdict_events WHERE decision_id = ?')
                .get(existing.id) as { n: number }
            ).n > 0;
          if (!backed) {
            const participant = this.upsertParticipant('agent', input.agent ?? 'agent');
            this.db
              .prepare(
                `INSERT INTO verdict_events (id, decision_id, from_state, to_state, participant_id, reason, at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                newId('vrd'),
                existing.id,
                decision.status,
                'pending',
                participant.id,
                RECLAIM_REASON,
                now(),
              );
            this.db
              .prepare('UPDATE decisions SET status = ?, decided_at = NULL WHERE id = ?')
              .run('pending', existing.id);
            this.syncFts(existing.id);
            return {
              decision: this.getDecision(existing.id)!,
              version,
              deduped: true,
              reclaimed: true,
            };
          }
        }
        return { decision, version, deduped: true };
      }

      const at = input.at ?? now();
      const decision: Decision = {
        id: newId('dec'),
        projectId: project.id,
        sessionId: session?.id ?? null,
        kind: input.kind,
        title: input.title,
        status: input.initialStatus ?? 'pending',
        source: input.source,
        contentHash: hash,
        pinnedCommit: input.pinnedCommit ?? null,
        createdAt: at,
        decidedAt: input.initialStatus && input.initialStatus !== 'pending' ? at : null,
      };

      this.db
        .prepare(
          `INSERT INTO decisions
             (id, project_id, session_id, kind, title, status, source, content_hash, pinned_commit, created_at, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          decision.id,
          decision.projectId,
          decision.sessionId,
          decision.kind,
          decision.title,
          decision.status,
          decision.source,
          decision.contentHash,
          decision.pinnedCommit,
          decision.createdAt,
          decision.decidedAt,
        );

      this.recordProvenance(decision.id, input.source, input.sessionRef ?? null);

      const version = this.addVersion(decision.id, input.body, null, input.contextRefs ?? null);

      this.syncFts(decision.id);
      return { decision, version, deduped: false };
    });

    return tx();
  }

  private recordProvenance(decisionId: string, source: Source, detail: string | null): void {
    this.db
      .prepare(
        `INSERT INTO decision_provenance (decision_id, source, detail, seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (decision_id, source) DO NOTHING`,
      )
      .run(decisionId, source, detail, now());
  }

  addVersion(
    decisionId: string,
    bodyMd: string,
    parentVersionId: string | null,
    contextRefs: string[] | null,
  ): Version {
    const nextNum =
      ((
        this.db
          .prepare('SELECT MAX(num) AS m FROM versions WHERE decision_id = ?')
          .get(decisionId) as {
          m: number | null;
        }
      ).m ?? 0) + 1;

    const version: Version = {
      id: newId('ver'),
      decisionId,
      num: nextNum,
      bodyMd,
      parentVersionId,
      contextRefs,
      submittedAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO versions (id, decision_id, num, body_md, parent_version_id, context_refs, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version.id,
        version.decisionId,
        version.num,
        version.bodyMd,
        version.parentVersionId,
        contextRefs ? JSON.stringify(contextRefs) : null,
        version.submittedAt,
      );
    this.syncFts(decisionId);
    return version;
  }

  // ---------- reads ----------

  getDecision(id: string): Decision | null {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as
      | DecisionRow
      | undefined;
    return row ? this.rowToDecision(row) : null;
  }

  latestVersion(decisionId: string): Version | null {
    const row = this.db
      .prepare('SELECT * FROM versions WHERE decision_id = ? ORDER BY num DESC LIMIT 1')
      .get(decisionId) as Record<string, unknown> | undefined;
    return row ? this.rowToVersion(row) : null;
  }

  getVersion(decisionId: string, num: number): Version | null {
    const row = this.db
      .prepare('SELECT * FROM versions WHERE decision_id = ? AND num = ?')
      .get(decisionId, num) as Record<string, unknown> | undefined;
    return row ? this.rowToVersion(row) : null;
  }

  listVersions(decisionId: string): Version[] {
    return (
      this.db
        .prepare('SELECT * FROM versions WHERE decision_id = ? ORDER BY num ASC')
        .all(decisionId) as Record<string, unknown>[]
    ).map((r) => this.rowToVersion(r));
  }

  listComments(decisionId: string): Comment[] {
    return (
      this.db
        .prepare('SELECT * FROM comments WHERE decision_id = ? ORDER BY created_at ASC')
        .all(decisionId) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as string,
      decisionId: r.decision_id as string,
      versionId: (r.version_id as string) ?? null,
      participantId: r.participant_id as string,
      anchorQuote: (r.anchor_quote as string) ?? null,
      body: r.body as string,
      createdAt: r.created_at as number,
      deliveredAt: (r.delivered_at as number) ?? null,
    }));
  }

  listVerdicts(decisionId: string): VerdictEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM verdict_events WHERE decision_id = ? ORDER BY at ASC')
        .all(decisionId) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as string,
      decisionId: r.decision_id as string,
      fromState: r.from_state as DecisionStatus,
      toState: r.to_state as DecisionStatus,
      participantId: r.participant_id as string,
      reason: (r.reason as string) ?? null,
      at: r.at as number,
    }));
  }

  getDecisionDetail(id: string): DecisionDetail | null {
    const decision = this.getDecision(id);
    if (!decision) return null;
    const projectName = (
      this.db.prepare('SELECT name FROM projects WHERE id = ?').get(decision.projectId) as {
        name: string;
      }
    ).name;
    const provenance = (
      this.db
        .prepare('SELECT source, detail, seen_at FROM decision_provenance WHERE decision_id = ?')
        .all(id) as Record<string, unknown>[]
    ).map((r) => ({
      source: r.source as Source,
      detail: (r.detail as string) ?? null,
      seenAt: r.seen_at as number,
    }));

    return {
      ...decision,
      projectName,
      versions: this.listVersions(id),
      comments: this.listComments(id),
      verdicts: this.listVerdicts(id),
      provenance,
    };
  }

  listDecisions(
    filters: SearchFilters = {},
  ): Array<Decision & { projectName: string; versionCount: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.project) {
      where.push('p.name = ?');
      params.push(filters.project);
    }
    if (filters.status) {
      where.push('d.status = ?');
      params.push(filters.status);
    }
    if (filters.kind) {
      where.push('d.kind = ?');
      params.push(filters.kind);
    }
    if (filters.since) {
      where.push('d.created_at >= ?');
      params.push(filters.since);
    }
    const sql = `
      SELECT d.*, p.name AS project_name,
             (SELECT COUNT(*) FROM versions v WHERE v.decision_id = d.id) AS version_count
      FROM decisions d JOIN projects p ON p.id = d.project_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE d.status WHEN 'pending' THEN 0 WHEN 'changes_requested' THEN 1 ELSE 2 END,
               d.created_at DESC
      LIMIT ?`;
    params.push(filters.limit ?? 200);

    return (
      this.db.prepare(sql).all(...params) as Array<
        DecisionRow & { project_name: string; version_count: number }
      >
    ).map((r) => ({
      ...this.rowToDecision(r),
      projectName: r.project_name,
      versionCount: r.version_count,
    }));
  }

  listProjects(): Array<Project & { decisionCount: number; pendingCount: number }> {
    return (
      this.db
        .prepare(
          `SELECT p.*,
                  COUNT(d.id) AS decision_count,
                  SUM(CASE WHEN d.status IN ('pending','changes_requested') THEN 1 ELSE 0 END) AS pending_count
           FROM projects p LEFT JOIN decisions d ON d.project_id = p.id
           GROUP BY p.id ORDER BY p.name`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      rootPath: (r.root_path as string) ?? null,
      createdAt: r.created_at as number,
      decisionCount: Number(r.decision_count ?? 0),
      pendingCount: Number(r.pending_count ?? 0),
    }));
  }

  getSessionDecisions(sessionId: string): Decision[] {
    return (
      this.db
        .prepare('SELECT * FROM decisions WHERE session_id = ? ORDER BY created_at ASC')
        .all(sessionId) as DecisionRow[]
    ).map((r) => this.rowToDecision(r));
  }

  // ---------- verdicts & comments ----------

  applyVerdict(input: {
    decisionId: string;
    to: DecisionStatus;
    reason?: string | null;
    participant: Participant;
  }): VerdictEvent {
    const tx = this.db.transaction((): VerdictEvent => {
      const decision = this.getDecision(input.decisionId);
      if (!decision) throw new Error(`no such decision: ${input.decisionId}`);

      assertTransition(decision.status, input.to, input.reason);

      const event: VerdictEvent = {
        id: newId('vrd'),
        decisionId: decision.id,
        fromState: decision.status,
        toState: input.to,
        participantId: input.participant.id,
        reason: input.reason?.trim() || null,
        at: now(),
      };
      this.db
        .prepare(
          `INSERT INTO verdict_events (id, decision_id, from_state, to_state, participant_id, reason, at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.decisionId,
          event.fromState,
          event.toState,
          event.participantId,
          event.reason,
          event.at,
        );

      const decided = input.to === 'approved' || input.to === 'rejected' ? event.at : null;
      this.db
        .prepare(
          'UPDATE decisions SET status = ?, decided_at = COALESCE(?, decided_at) WHERE id = ?',
        )
        .run(input.to, decided, decision.id);

      this.syncFts(decision.id);
      return event;
    });
    return tx();
  }

  addComments(
    decisionId: string,
    participant: Participant,
    comments: Array<{ body: string; anchorQuote?: string | null; versionNum?: number }>,
  ): Comment[] {
    const tx = this.db.transaction((): Comment[] => {
      const out: Comment[] = [];
      for (const c of comments) {
        const version = c.versionNum
          ? this.getVersion(decisionId, c.versionNum)
          : this.latestVersion(decisionId);
        const comment: Comment = {
          id: newId('cmt'),
          decisionId,
          versionId: version?.id ?? null,
          participantId: participant.id,
          anchorQuote: c.anchorQuote?.trim() || null,
          body: c.body,
          createdAt: now(),
          deliveredAt: null,
        };
        this.db
          .prepare(
            `INSERT INTO comments (id, decision_id, version_id, participant_id, anchor_quote, body, created_at, delivered_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            comment.id,
            comment.decisionId,
            comment.versionId,
            comment.participantId,
            comment.anchorQuote,
            comment.body,
            comment.createdAt,
          );
        out.push(comment);
      }
      return out;
    });
    return tx();
  }

  /**
   * What a polling agent gets back. Read-only and idempotent by design: it
   * reconstructs the outcome from committed rows, so a dropped connection, a
   * re-poll, or a daemon restart all return the same answer.
   */
  reviewOutcome(decisionId: string): ReviewOutcome | null {
    const decision = this.getDecision(decisionId);
    if (!decision) return null;

    const lastVerdict = this.listVerdicts(decisionId).at(-1) ?? null;
    // A comment belongs to the document it was said about: v1 feedback must
    // never read as feedback on v4.
    const numByVersionId = new Map(
      (
        this.db.prepare('SELECT id, num FROM versions WHERE decision_id = ?').all(decisionId) as {
          id: string;
          num: number;
        }[]
      ).map((v) => [v.id, v.num]),
    );
    const comments = this.listComments(decisionId).map((c) => {
      const author = this.db
        .prepare('SELECT name, type FROM participants WHERE id = ?')
        .get(c.participantId) as {
        name: string;
        type: ParticipantType;
      };
      return {
        body: c.body,
        anchorQuote: c.anchorQuote,
        author: author.name,
        authorType: author.type,
        createdAt: c.createdAt,
        onVersion: (c.versionId ? numByVersionId.get(c.versionId) : null) ?? null,
      };
    });

    return {
      status: decision.status,
      reason: lastVerdict?.toState === decision.status ? lastVerdict.reason : null,
      comments,
      version: this.latestVersion(decisionId)?.num ?? 1,
    };
  }

  markCommentsDelivered(decisionId: string): void {
    this.db
      .prepare(
        'UPDATE comments SET delivered_at = ? WHERE decision_id = ? AND delivered_at IS NULL',
      )
      .run(now(), decisionId);
  }

  // ---------- chat-bar messages (ADR-011) ----------

  addMessage(body: string, context: Record<string, string> | null): QueuedMessage {
    const msg: QueuedMessage = {
      id: newId('msg'),
      body,
      context,
      createdAt: now(),
      deliveredAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO messages (id, body, context, created_at, delivered_at) VALUES (?, ?, ?, ?, NULL)',
      )
      .run(msg.id, msg.body, msg.context ? JSON.stringify(msg.context) : null, msg.createdAt);
    return msg;
  }

  undeliveredMessages(): QueuedMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE delivered_at IS NULL ORDER BY created_at')
      .all() as Array<{
      id: string;
      body: string;
      context: string | null;
      created_at: number;
      delivered_at: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      body: r.body,
      context: r.context ? (JSON.parse(r.context) as Record<string, string>) : null,
      createdAt: r.created_at,
      deliveredAt: r.delivered_at,
    }));
  }

  markMessagesDelivered(ids: string[]): void {
    if (!ids.length) return;
    const stamp = this.db.prepare('UPDATE messages SET delivered_at = ? WHERE id = ?');
    const tx = this.db.transaction(() => {
      for (const id of ids) stamp.run(now(), id);
    });
    tx();
  }

  /**
   * How long after a message a project-level submission still counts as
   * plausibly related. Without a bound, every message eventually points at
   * whatever was submitted next — hours later and about something else
   * entirely — which reads as a connection that is not there. Two hours is a
   * working session; past that, "nothing since" is the more honest answer.
   */
  private static readonly ACTIVITY_WINDOW_MS = 2 * 60 * 60 * 1000;

  /**
   * The chat-bar history: what you said, and what came back.
   *
   * Delivery is a fact — `delivered_at` is stamped when the daemon hands the row
   * to a session. A *reaction* is an inference, so it is reported as one. Only a
   * message that named a decision can be correlated at all; anything typed from
   * a library or project page is `untracked`, never `none`, because "we cannot
   * tell" and "the agent ignored you" are different claims and the UI must not
   * merge them.
   *
   * The correlation is deliberately crude: the first agent comment or new
   * version on that decision after the message was sent. It can attribute work
   * the agent was already doing. It is a pointer to look at, not proof of cause.
   */
  messageHistory(limit = 50, offset = 0): MessageHistoryItem[] {
    const rows = this.db
      // rowid breaks the tie: two messages sent inside the same millisecond are
      // common (paste, hit enter, paste again) and created_at alone leaves their
      // order undefined — the same trap catchups already hit. It also makes
      // OFFSET paging stable, which an ambiguous sort would not be.
      .prepare('SELECT * FROM messages ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as Array<{
      id: string;
      body: string;
      context: string | null;
      created_at: number;
      delivered_at: number | null;
    }>;

    const firstComment = this.db.prepare(
      `SELECT c.id, c.body, c.created_at
         FROM comments c JOIN participants p ON p.id = c.participant_id
        WHERE c.decision_id = ? AND p.type = 'agent' AND c.created_at > ?
        ORDER BY c.created_at LIMIT 1`,
    );
    const firstVersion = this.db.prepare(
      `SELECT id, num, submitted_at FROM versions
        WHERE decision_id = ? AND submitted_at > ?
        ORDER BY submitted_at LIMIT 1`,
    );
    const projectActivity = this.db.prepare(
      `SELECT v.decision_id, v.num, v.submitted_at, d.title
         FROM versions v
         JOIN decisions d ON d.id = v.decision_id
         JOIN projects  p ON p.id = d.project_id
        WHERE p.name = ? AND v.submitted_at > ? AND v.submitted_at <= ?
        ORDER BY v.submitted_at LIMIT 1`,
    );

    return rows.map((r) => {
      const context = r.context ? (JSON.parse(r.context) as Record<string, string>) : null;
      const base = {
        id: r.id,
        body: r.body,
        context,
        createdAt: r.created_at,
        deliveredAt: r.delivered_at,
      };
      const decisionId = context?.decisionId;
      if (!decisionId) {
        // Most messages are typed from a project page, so a decision-only
        // correlation would report "not tracked" on nearly every row and the
        // history would be useless. A project is still a real handle: report the
        // next document the agent submitted there, explicitly as *activity*
        // rather than a reply, since only time links it to what you said.
        const project = context?.project;
        if (!project) return { ...base, reaction: { kind: 'untracked' } as MessageReaction };
        const a = projectActivity.get(
          project,
          r.created_at,
          r.created_at + Repository.ACTIVITY_WINDOW_MS,
        ) as { decision_id: string; title: string; num: number; submitted_at: number } | undefined;
        return {
          ...base,
          reaction: a
            ? {
                kind: 'activity',
                at: a.submitted_at,
                decisionId: a.decision_id,
                title: a.title,
                num: a.num,
              }
            : { kind: 'none' },
        };
      }

      const c = firstComment.get(decisionId, r.created_at) as
        | { id: string; body: string; created_at: number }
        | undefined;
      const v = firstVersion.get(decisionId, r.created_at) as
        | { id: string; num: number; submitted_at: number }
        | undefined;

      // A revision answers feedback more concretely than a reply does, so when
      // both exist the earlier one wins — whichever the agent reached for first.
      if (v && (!c || v.submitted_at <= c.created_at)) {
        return {
          ...base,
          reaction: { kind: 'version', at: v.submitted_at, decisionId, ref: v.id, num: v.num },
        };
      }
      if (c) {
        return {
          ...base,
          reaction: {
            kind: 'comment',
            at: c.created_at,
            decisionId,
            ref: c.id,
            excerpt: c.body.slice(0, 140),
          },
        };
      }
      return { ...base, reaction: { kind: 'none' } as MessageReaction };
    });
  }

  // ---------- search & constraints ----------

  search(query: string, filters: SearchFilters = {}): SearchHit[] {
    const rows = this.db
      .prepare(
        `SELECT f.decision_id AS decision_id,
                snippet(decisions_fts, 1, '[', ']', '…', 12) AS snippet
         FROM decisions_fts f
         WHERE decisions_fts MATCH ?
         ORDER BY bm25(decisions_fts)
         LIMIT ?`,
      )
      .all(escapeFts(query), (filters.limit ?? 20) * 4) as Array<{
      decision_id: string;
      snippet: string;
    }>;

    const hits: SearchHit[] = [];
    for (const row of rows) {
      const detail = this.getDecisionDetail(row.decision_id);
      if (!detail) continue;
      if (filters.project && detail.projectName !== filters.project) continue;
      if (filters.status && detail.status !== filters.status) continue;
      if (filters.kind && detail.kind !== filters.kind) continue;
      if (filters.since && detail.createdAt < filters.since) continue;
      if (filters.until && detail.createdAt > filters.until) continue;

      hits.push({
        decisionId: detail.id,
        title: detail.title,
        kind: detail.kind,
        status: detail.status,
        projectName: detail.projectName,
        reason: lastReason(detail.verdicts),
        snippet: row.snippet,
        createdAt: detail.createdAt,
      });
      if (hits.length >= (filters.limit ?? 20)) break;
    }
    return hits;
  }

  /**
   * The pre-design briefing: what an agent must know before proposing anything,
   * including what has already been turned down and why. Queryless on purpose —
   * an agent cannot search for a constraint it does not know exists.
   */
  constraints(
    project: string,
    topic?: string,
  ): {
    project: string;
    accepted: Array<{
      title: string;
      kind: DecisionKind;
      decidedAt: number | null;
      reason: string | null;
    }>;
    rejected: Array<{
      title: string;
      kind: DecisionKind;
      decidedAt: number | null;
      reason: string | null;
    }>;
  } {
    const all = this.listDecisions({ project, limit: 500 });
    const relevant = topic
      ? all.filter((d) => {
          const body = this.latestVersion(d.id)?.bodyMd ?? '';
          const needle = topic.toLowerCase();
          return d.title.toLowerCase().includes(needle) || body.toLowerCase().includes(needle);
        })
      : all;

    const shape = (d: Decision) => ({
      title: d.title,
      kind: d.kind,
      decidedAt: d.decidedAt,
      reason: lastReason(this.listVerdicts(d.id)),
    });

    return {
      project,
      accepted: relevant.filter((d) => d.status === 'approved').map(shape),
      rejected: relevant.filter((d) => d.status === 'rejected').map(shape),
    };
  }

  // ---------- catchup ----------

  /** Generate a project's catchup briefing from the live store (the button).
   *  The authored sections of the project-state standard, filled from real
   *  data — no hand-maintained narrative, always current. */
  projectCatchup(project: string): ProjectCatchup {
    const all = this.listDecisions({ project, limit: 500 });
    const toItem = (d: Decision): CatchupItem => ({
      id: d.id,
      title: d.title,
      kind: d.kind,
      status: d.status,
      createdAt: d.createdAt,
      decidedAt: d.decidedAt,
      // The "why" is the human's rationale — but the ADR-008 reclaim writes a
      // system reason with no human behind it, so treat that as no rationale
      // and let the doc's TL;DR speak instead.
      reason: systemToNull(lastReason(this.listVerdicts(d.id))),
      tldr: firstMeaningfulLine(this.latestVersion(d.id)?.bodyMd ?? null),
    });
    const items = all.map(toItem);
    const isOpen = (s: DecisionStatus) => s === 'pending' || s === 'changes_requested';

    const rightNow = items.filter((d) => isOpen(d.status));
    // Loud: red lights, plus bug reports that aren't resolved (still open).
    const critical = items.filter(
      (d) => d.status === 'rejected' || (d.kind === 'bug' && isOpen(d.status)),
    );
    const keyDecisions = items.filter((d) => d.status === 'approved').slice(0, 8);

    // One timeline entry per decision — its most recent event — newest first.
    const activity = items
      .map((d) => ({
        at: d.decidedAt ?? d.createdAt,
        label: labelFor(d.status),
        id: d.id,
        title: d.title,
        kind: d.kind,
      }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 15);

    const lastActivity = items.length
      ? Math.max(...items.map((d) => d.decidedAt ?? d.createdAt))
      : null;

    return {
      project,
      generatedAt: now(),
      stats: {
        decisions: items.length,
        needsYou: rightNow.length,
        redLights: items.filter((d) => d.status === 'rejected').length,
        bugs: items.filter((d) => d.kind === 'bug').length,
        lastActivity,
      },
      rightNow,
      critical,
      keyDecisions,
      activity,
    };
  }

  // ---------- remembered session bindings (ADR-016) ----------

  /** Remember which projects a session launched from `cwd` answers for, so the
   *  binding survives a daemon restart. The cwd is an opaque key — compared,
   *  never resolved or executed. Bounded so a hostile caller cannot bloat the
   *  row. An empty list forgets the binding rather than storing a useless one. */
  saveBinding(cwd: string, projects: string[]): void {
    const key = cwd.slice(0, 512);
    const clean = [...new Set(projects.map((p) => p.trim().slice(0, 120)).filter(Boolean))].slice(
      0,
      10,
    );
    if (!clean.length) {
      this.db.prepare('DELETE FROM session_bindings WHERE cwd = ?').run(key);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO session_bindings (cwd, projects, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(cwd) DO UPDATE SET projects = excluded.projects, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(clean), now());
  }

  /** The remembered binding for a launch directory, or null. */
  bindingFor(cwd: string): string[] | null {
    const row = this.db
      .prepare('SELECT projects FROM session_bindings WHERE cwd = ?')
      .get(cwd.slice(0, 512)) as { projects: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.projects) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((p): p is string => typeof p === 'string')
        : null;
    } catch {
      return null;
    }
  }

  // ---------- agent-generated catchups ----------

  /** Store a catchup the agent generated. Each call is a new version; the
   *  latest by created_at is what the project page shows. */
  recordCatchup(input: { project: string; bodyMd: string; generatedBy?: string | null }): Catchup {
    const project = this.upsertProject(input.project);
    const cu: Catchup = {
      id: newId('cu'),
      project: input.project,
      bodyMd: input.bodyMd,
      generatedBy: input.generatedBy ?? null,
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO catchups (id, project_id, body_md, generated_by, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(cu.id, project.id, cu.bodyMd, cu.generatedBy, cu.createdAt);
    return cu;
  }

  /** The current catchup for a project — the most recent generation. */
  latestCatchup(project: string): Catchup | null {
    const row = this.db
      .prepare(
        `SELECT c.* FROM catchups c JOIN projects p ON p.id = c.project_id
         WHERE p.name = ? ORDER BY c.created_at DESC, c.rowid DESC LIMIT 1`,
      )
      .get(project) as CatchupRow | undefined;
    return row ? rowToCatchup(row, project) : null;
  }

  /** Past generations, newest first — the version history behind the catchup. */
  catchupHistory(project: string, limit = 20): Catchup[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM catchups c JOIN projects p ON p.id = c.project_id
         WHERE p.name = ? ORDER BY c.created_at DESC, c.rowid DESC LIMIT ?`,
      )
      .all(project, limit) as CatchupRow[];
    return rows.map((r) => rowToCatchup(r, project));
  }

  // ---------- fts ----------

  /** FTS is a derived index: rebuilt from decisions + latest body + latest reason. */
  syncFts(decisionId: string): void {
    const decision = this.getDecision(decisionId);
    if (!decision) return;
    const body = this.latestVersion(decisionId)?.bodyMd ?? '';
    const reason = lastReason(this.listVerdicts(decisionId)) ?? '';

    this.db.prepare('DELETE FROM decisions_fts WHERE decision_id = ?').run(decisionId);
    this.db
      .prepare('INSERT INTO decisions_fts (title, body, reason, decision_id) VALUES (?, ?, ?, ?)')
      .run(decision.title, body, reason, decisionId);
  }

  // ---------- mapping ----------

  private rowToDecision(r: DecisionRow): Decision {
    return {
      id: r.id,
      projectId: r.project_id,
      sessionId: r.session_id,
      kind: r.kind,
      title: r.title,
      status: r.status,
      source: r.source,
      contentHash: r.content_hash,
      pinnedCommit: r.pinned_commit,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
    };
  }

  private rowToVersion(r: Record<string, unknown>): Version {
    return {
      id: r.id as string,
      decisionId: r.decision_id as string,
      num: r.num as number,
      bodyMd: r.body_md as string,
      parentVersionId: (r.parent_version_id as string) ?? null,
      contextRefs: r.context_refs ? (JSON.parse(r.context_refs as string) as string[]) : null,
      submittedAt: r.submitted_at as number,
    };
  }
}

function rowToCatchup(r: CatchupRow, project: string): Catchup {
  return {
    id: r.id,
    project,
    bodyMd: r.body_md,
    generatedBy: r.generated_by,
    createdAt: r.created_at,
  };
}

/** The reason written by the ADR-008 reclaim — a system event, not a human
 *  rationale. Shared so the catchup can tell it apart from a real "why". */
const RECLAIM_REASON = 'reclaimed for review: no verdict backed this status';

/** System-authored reasons are not rationale; treat them as absent so a
 *  briefing falls back to the doc's TL;DR instead of showing plumbing. */
function systemToNull(reason: string | null): string | null {
  return reason === RECLAIM_REASON ? null : reason;
}

function lastReason(verdicts: VerdictEvent[]): string | null {
  for (let i = verdicts.length - 1; i >= 0; i--) {
    if (verdicts[i].reason) return verdicts[i].reason;
  }
  return null;
}

/** A doc's TL;DR at a glance: the first line of real prose. Skips headings,
 *  the metadata line, blockquote/callout markers, list bullets, and code
 *  fences; strips inline markdown; returns null if there's nothing to say. */
function firstMeaningfulLine(body: string | null): string | null {
  if (!body) return null;
  let inFence = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.startsWith('#')) continue; // heading
    // Strip a leading list/quote marker and inline markdown emphasis/code/links.
    const text = line
      .replace(/^[>\-*+]\s*/, '')
      .replace(/^\d+\.\s*/, '')
      .replace(/[*_`]/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .trim();
    if (!text) continue;
    // The metadata row under the H1 — both the ADR format ("Status: … · Date:")
    // and the bug format ("Kind: bug · Severity: …"). Not a gist; skip it.
    if (/^(kind|status|severity|date|project|read\s*time)\s*:/i.test(text)) continue;
    return text.length > 200 ? `${text.slice(0, 197)}…` : text;
  }
  return null;
}

/** Human label for a decision's current state in the activity timeline. */
function labelFor(status: DecisionStatus): string {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'changes_requested':
      return 'changes requested';
    default:
      return 'submitted';
  }
}

/** FTS5 treats bare punctuation as syntax; quote each term so user text is literal. */
function escapeFts(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t}"`).join(' OR ');
}
