export type DecisionKind = 'plan' | 'adr' | 'prd' | 'arch';

export type DecisionStatus =
  | 'pending'
  | 'changes_requested'
  | 'approved'
  | 'rejected'
  | 'superseded';

export type Source = 'mcp' | 'watcher';

export type ParticipantType = 'human' | 'agent' | 'reviewer';

/** Terminal states: the agent's long-poll resolves on any of these. */
export const RESOLVED_STATES: readonly DecisionStatus[] = [
  'approved',
  'rejected',
  'changes_requested',
];

export function isResolved(status: DecisionStatus): boolean {
  return RESOLVED_STATES.includes(status);
}

export interface Project {
  id: string;
  name: string;
  rootPath: string | null;
  createdAt: number;
}

export interface Session {
  id: string;
  projectId: string;
  agent: string | null;
  externalRef: string | null;
  startedAt: number;
}

export interface Participant {
  id: string;
  type: ParticipantType;
  name: string;
}

export interface Decision {
  id: string;
  projectId: string;
  sessionId: string | null;
  kind: DecisionKind;
  title: string;
  status: DecisionStatus;
  source: Source;
  contentHash: string;
  pinnedCommit: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface Version {
  id: string;
  decisionId: string;
  num: number;
  bodyMd: string;
  parentVersionId: string | null;
  contextRefs: string[] | null;
  submittedAt: number;
}

export interface Comment {
  id: string;
  decisionId: string;
  versionId: string | null;
  participantId: string;
  anchorQuote: string | null;
  body: string;
  createdAt: number;
  deliveredAt: number | null;
}

export interface VerdictEvent {
  id: string;
  decisionId: string;
  fromState: DecisionStatus;
  toState: DecisionStatus;
  participantId: string;
  reason: string | null;
  at: number;
}

/** What an agent's get_review poll resolves to. */
export interface ReviewOutcome {
  status: DecisionStatus;
  reason: string | null;
  comments: Array<{
    body: string;
    anchorQuote: string | null;
    author: string;
    /** Who is speaking. The thread is multi-party: humans, agents, and
     *  role-scoped reviewers all comment; only a human can decide. */
    authorType: ParticipantType;
    createdAt: number;
  }>;
  version: number;
}

export interface DecisionDetail extends Decision {
  projectName: string;
  versions: Version[];
  comments: Comment[];
  verdicts: VerdictEvent[];
  provenance: Array<{ source: Source; detail: string | null; seenAt: number }>;
}

export interface SearchHit {
  decisionId: string;
  title: string;
  kind: DecisionKind;
  status: DecisionStatus;
  projectName: string;
  reason: string | null;
  snippet: string;
  createdAt: number;
}

export interface SearchFilters {
  project?: string;
  status?: DecisionStatus;
  kind?: DecisionKind;
  since?: number;
  until?: number;
  limit?: number;
}
