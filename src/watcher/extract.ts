import { basename } from 'node:path';
import type { DecisionKind } from '../domain/types.js';

/**
 * Extractors for Claude Code's transcript JSONL.
 *
 * This format is undocumented and version-dependent, so every function here is
 * a small pure function over one parsed line, and every access is guarded: a
 * shape we don't recognize yields null. Ingestion must never crash on a
 * transcript we've never seen.
 */

export interface CapturedDoc {
  kind: DecisionKind;
  title: string;
  body: string;
  /** transcript uuid of the originating entry — globally unique, our idempotency key */
  entryUuid: string;
  sessionId: string;
  projectName: string;
  filePath?: string;
  at: number;
}

export interface Line {
  type?: string;
  uuid?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  isSidechain?: boolean;
  agentId?: string;
  message?: { content?: unknown };
  toolUseResult?: unknown;
}

/** Only `<project-slug>/<uuid>.jsonl` is a real session; subagent and workflow
 *  transcripts sit deeper and would double-count every decision. */
const SESSION_FILE =
  /\.claude\/projects\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

export function isSessionTranscript(path: string): boolean {
  return SESSION_FILE.test(path) && !path.includes('/subagents/') && !path.includes('/workflows/');
}

export function parseLine(raw: string): Line | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Line;
  } catch {
    return null; // A half-written line: the next tail pass will see it whole.
  }
}

function blocks(line: Line): Array<Record<string, unknown>> {
  const content = line.message?.content;
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

export function isIgnorable(line: Line): boolean {
  return line.isSidechain === true || typeof line.agentId === 'string';
}

/** Finds an ExitPlanMode tool_use and returns its id + plan text. */
export function findPlanSubmission(line: Line): { toolUseId: string; plan: string } | null {
  if (line.type !== 'assistant' || isIgnorable(line)) return null;
  for (const block of blocks(line)) {
    if (block.type !== 'tool_use' || block.name !== 'ExitPlanMode') continue;
    const input = block.input as { plan?: unknown } | undefined;
    const plan = input?.plan;
    const id = block.id;
    if (typeof plan === 'string' && plan.trim() && typeof id === 'string') {
      return { toolUseId: id, plan };
    }
  }
  return null;
}

export type PlanOutcome = 'approved' | 'rejected' | 'interrupted' | 'unknown';

/**
 * Approved vs rejected, from the tool_result that answers a plan.
 *
 * The reliable discriminator is the *type* of the top-level toolUseResult:
 * an object carrying `plan` means approved; the literal string
 * "User rejected tool use" means rejected. The prose in the result body says
 * the same thing but its wording drifts between versions, so it's only a
 * fallback.
 */
export function findPlanOutcome(
  line: Line,
): { toolUseId: string; outcome: PlanOutcome; plan?: string } | null {
  if (line.type !== 'user' || isIgnorable(line)) return null;

  for (const block of blocks(line)) {
    if (block.type !== 'tool_result') continue;
    const toolUseId = block.tool_use_id;
    if (typeof toolUseId !== 'string') continue;

    const result = line.toolUseResult;

    if (result && typeof result === 'object' && 'plan' in (result as Record<string, unknown>)) {
      const plan = (result as { plan?: unknown }).plan;
      return {
        toolUseId,
        outcome: 'approved',
        plan: typeof plan === 'string' ? plan : undefined,
      };
    }

    if (typeof result === 'string' && result.toLowerCase().includes('rejected')) {
      return { toolUseId, outcome: 'rejected' };
    }

    if (block.is_error === true) {
      const content = typeof block.content === 'string' ? block.content : '';
      if (content.includes('interrupted')) return { toolUseId, outcome: 'interrupted' };
      return { toolUseId, outcome: 'rejected' };
    }

    const content = typeof block.content === 'string' ? block.content : '';
    if (content.startsWith('User has approved your plan')) {
      return { toolUseId, outcome: 'approved' };
    }
    return { toolUseId, outcome: 'unknown' };
  }
  return null;
}

const DOC_PATH = /\/docs?\/.*\.mdx?$/i;
const EXCLUDED_PATH = /\/(scratchpad|node_modules|\.claude\/projects)\//;

/** A markdown doc written into a repo's docs/ — the decision-shaped file writes. */
export function findDocWrite(line: Line): { filePath: string; content: string } | null {
  if (line.type !== 'assistant' || isIgnorable(line)) return null;

  for (const block of blocks(line)) {
    if (block.type !== 'tool_use') continue;
    if (block.name !== 'Write') continue;
    const input = block.input as { file_path?: unknown; content?: unknown } | undefined;
    const filePath = input?.file_path;
    const content = input?.content;
    if (typeof filePath !== 'string' || typeof content !== 'string') continue;
    if (!DOC_PATH.test(filePath) || EXCLUDED_PATH.test(filePath)) continue;
    if (!content.trim()) continue;
    return { filePath, content };
  }
  return null;
}

/** docs/adr/ADR-002-foo.md → adr; a plan is a plan; everything else is arch. */
export function classifyDoc(filePath: string): DecisionKind {
  const lower = filePath.toLowerCase();
  if (lower.includes('/adr')) return 'adr';
  if (lower.includes('prd')) return 'prd';
  if (lower.includes('plan')) return 'plan';
  return 'arch';
}

export function titleFromMarkdown(body: string, fallback: string): string {
  for (const raw of body.split('\n', 40)) {
    const line = raw.trim();
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    if (heading) return heading[1].replace(/[#*`]/g, '').trim().slice(0, 160);
  }
  return fallback;
}

/**
 * `-Users-ivankwong-Projects-accounting-app` → `accounting-app`.
 * The slug is lossy (underscores became hyphens), so this is a display name,
 * never a path we resolve against.
 */
export function projectNameFromDir(dirName: string): string {
  const parts = dirName.split('-').filter(Boolean);
  return parts.at(-1) ?? dirName;
}

/** Derive the project from the written file's own path when we can — cwd lies:
 *  a session in one repo routinely writes docs into another. */
export function projectNameFromFilePath(filePath: string): string | null {
  const match = /\/([^/]+)\/(?:docs?)\//i.exec(filePath);
  return match ? match[1] : null;
}

export function docToCapture(
  line: Line,
  doc: { filePath: string; content: string },
  transcriptPath: string,
): CapturedDoc | null {
  if (!line.uuid || !line.sessionId) return null;
  const project =
    projectNameFromFilePath(doc.filePath) ?? projectNameFromDir(basename(transcriptPath, '.jsonl'));

  return {
    kind: classifyDoc(doc.filePath),
    title: titleFromMarkdown(doc.content, basename(doc.filePath, '.md')),
    body: doc.content,
    entryUuid: line.uuid,
    sessionId: line.sessionId,
    projectName: project,
    filePath: doc.filePath,
    at: line.timestamp ? Date.parse(line.timestamp) : Date.now(),
  };
}
