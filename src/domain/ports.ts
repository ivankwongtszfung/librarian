import type {
  Catchup,
  Comment,
  Constraints,
  Decision,
  DecisionDetail,
  DecisionStatus,
  Notification,
  Participant,
  ParticipantType,
  Project,
  ProjectCatchup,
  ReviewOutcome,
  SearchFilters,
  SearchHit,
  SubmitInput,
  SubmitResult,
  VerdictEvent,
  Version,
} from './types.js';

/**
 * The store port — the persistence seam the application and interface layers
 * depend on, so neither knows the concrete store (SQLite today).
 *
 * Per the Dependency Rule (ADR-005) the interface is owned by the domain; the
 * adapter that fulfils it lives in infrastructure and is named only at the
 * composition root. Swapping the store, or faking it in a test, is a matter of
 * implementing this — the use cases never change.
 */
export interface DecisionStore {
  submit(input: SubmitInput): SubmitResult;
  applyVerdict(input: {
    decisionId: string;
    to: DecisionStatus;
    reason?: string | null;
    participant: Participant;
  }): VerdictEvent;
  addComments(
    decisionId: string,
    participant: Participant,
    comments: Array<{ body: string; anchorQuote?: string | null; versionNum?: number }>,
  ): Comment[];
  upsertParticipant(type: ParticipantType, name: string): Participant;
  markCommentsDelivered(decisionId: string): void;
  reviewOutcome(decisionId: string): ReviewOutcome | null;
  getVersion(decisionId: string, num: number): Version | null;
  getDecisionDetail(id: string): DecisionDetail | null;
  listDecisions(
    filters?: SearchFilters,
  ): Array<Decision & { projectName: string; versionCount: number }>;
  listProjects(): Array<Project & { decisionCount: number; pendingCount: number }>;
  getSessionDecisions(sessionId: string): Decision[];
  search(query: string, filters?: SearchFilters): SearchHit[];
  constraints(project: string, topic?: string): Constraints;
  projectCatchup(project: string): ProjectCatchup;

  // Remembered session bindings (ADR-016), keyed by launch directory so a
  // binding outlives both the daemon and the session that set it.
  saveBinding(cwd: string, projects: string[]): void;
  bindingFor(cwd: string): string[] | null;

  // Agent-generated catchups (the "Catch me up" button): stored, versioned.
  recordCatchup(input: { project: string; bodyMd: string; generatedBy?: string | null }): Catchup;
  latestCatchup(project: string): Catchup | null;
  catchupHistory(project: string, limit?: number): Catchup[];

  // Chat-bar messages (ADR-011): durable rows, delivered in batches. "Sent"
  // is only ever claimed about a committed row.
  addMessage(body: string, context: Record<string, string> | null): QueuedMessage;
  undeliveredMessages(): QueuedMessage[];
  markMessagesDelivered(ids: string[]): void;
  messageHistory(limit?: number, offset?: number): MessageHistoryItem[];
}

export interface QueuedMessage {
  id: string;
  body: string;
  context: Record<string, string> | null;
  createdAt: number;
  deliveredAt: number | null;
}

/**
 * What the agent did after a message reached it — or, honestly, whether we can
 * tell at all. Delivery is a fact the daemon owns; a *reaction* is an inference,
 * and only a message that named a decision can be correlated to one.
 */
export type MessageReaction =
  // Strong: the message named a decision, and the agent then answered on it.
  | { kind: 'comment'; at: number; decisionId: string; ref: string; excerpt: string }
  | { kind: 'version'; at: number; decisionId: string; ref: string; num: number }
  // Weak: the message named only a project, and the agent then did something in
  // it. Correlation by time alone — the UI must not phrase this as a reply.
  | { kind: 'activity'; at: number; decisionId: string; title: string; num: number }
  | { kind: 'none' }
  | { kind: 'untracked' };

export interface MessageHistoryItem extends QueuedMessage {
  reaction: MessageReaction;
}

/** Push-notification sink — the daemon's outbound alert channel (ntfy today). */
export interface Notifier {
  publish(n: Notification): Promise<void>;
  sent(): readonly Notification[];
}
