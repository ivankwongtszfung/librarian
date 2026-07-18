import { createReadStream, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import chokidar, { type FSWatcher } from 'chokidar';
import type { EventBus } from '../../application/events.js';
import type { DecisionStore } from '../../domain/ports.js';
import {
  type CapturedDoc,
  type Line as TranscriptLine,
  docToCapture,
  findDocWrite,
  findPlanOutcome,
  findPlanSubmission,
  isIgnorable,
  isSessionTranscript,
  parseLine,
  projectNameFromDir,
  titleFromMarkdown,
} from './extract.js';

interface FileCursor {
  offset: number;
  inode: number;
}

/**
 * The safety net: captures decisions from agent transcripts even when the agent
 * never calls submit_for_review. It only ever reads.
 *
 * Two signals are captured: an approved plan (ExitPlanMode), and a markdown doc
 * written into a repo's docs/ directory. In practice the second is the common
 * one by a wide margin — plan approvals are rare in real transcripts, doc writes
 * are not.
 */
export class TranscriptWatcher {
  private watcher?: FSWatcher;
  private readonly cursors = new Map<string, FileCursor>();
  private readonly pendingPlans = new Map<
    string,
    { plan: string; sessionId: string; uuid: string }
  >();
  private readonly seenEntries = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private ready = false;

  constructor(
    private readonly rootDir: string,
    private readonly repo: DecisionStore,
    private readonly bus: EventBus,
    /** Capture only what arrives after start; the backlog is a separate concern. */
    private readonly fromBeginning = false,
  ) {}

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.rootDir, {
      ignoreInitial: false,
      persistent: true,
      ignored: (p) => p.includes('/subagents/') || p.includes('/workflows/'),
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
    });

    // Transcripts that already existed when we started are backlog: note their
    // size and ignore their contents. Anything that appears or grows *after*
    // that is live, and must be read from where we left off.
    this.watcher.on('add', (path) => this.enqueue(path, !this.ready && !this.fromBeginning));
    this.watcher.on('change', (path) => this.enqueue(path, false));

    await new Promise<void>((resolve) => {
      this.watcher!.on('ready', () => resolve());
    });
    await this.queue;
    this.ready = true;
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    await this.queue;
  }

  /** Serializes reads so two rapid changes to one file can't interleave. */
  private enqueue(path: string, skipExisting: boolean): void {
    if (!isSessionTranscript(path)) return;
    this.queue = this.queue.then(() => this.consume(path, skipExisting)).catch(() => undefined);
  }

  /** Test seam: await everything queued so far. */
  async drain(): Promise<void> {
    await this.queue;
  }

  private async consume(path: string, skipExisting: boolean): Promise<void> {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      return;
    }

    const cursor = this.cursors.get(path);

    // A file that shrank or was replaced (Claude Code renames orphaned
    // sessions) has to be re-read from zero. Capture stays idempotent because
    // every entry carries a uuid we've already seen.
    const rotated = cursor && (stat.ino !== cursor.inode || stat.size < cursor.offset);
    let start = rotated ? 0 : (cursor?.offset ?? 0);

    if (!cursor && skipExisting) {
      this.cursors.set(path, { offset: stat.size, inode: stat.ino });
      return;
    }
    if (start >= stat.size) {
      this.cursors.set(path, { offset: stat.size, inode: stat.ino });
      return;
    }

    const stream = createReadStream(path, { start, encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

    for await (const raw of rl) {
      start += Buffer.byteLength(raw, 'utf8') + 1;
      const line = parseLine(raw);
      if (!line || isIgnorable(line)) continue;
      try {
        this.handleLine(line, path);
      } catch {
        // A shape we don't understand is a missed capture, never a crash.
      }
    }

    this.cursors.set(path, { offset: stat.size, inode: stat.ino });
  }

  private handleLine(typed: TranscriptLine, path: string): void {
    const submission = findPlanSubmission(typed);
    if (submission) {
      this.pendingPlans.set(submission.toolUseId, {
        plan: submission.plan,
        sessionId: (typed.sessionId as string) ?? '',
        uuid: (typed.uuid as string) ?? '',
      });
      return;
    }

    const outcome = findPlanOutcome(typed);
    if (outcome) {
      const pending = this.pendingPlans.get(outcome.toolUseId);
      // Only an approved plan is a decision. A rejected or interrupted one is
      // not a red light either — the human never ruled on it here, they just
      // stopped the agent.
      if (pending && outcome.outcome === 'approved') {
        this.pendingPlans.delete(outcome.toolUseId);
        const body = outcome.plan ?? pending.plan;
        this.capture(
          {
            kind: 'plan',
            title: titleFromMarkdown(body, 'Approved plan'),
            body,
            entryUuid: pending.uuid || (typed.uuid as string) || '',
            sessionId: pending.sessionId || ((typed.sessionId as string) ?? ''),
            projectName: projectNameFromDir(basename(dirname(path))),
            at: typed.timestamp ? Date.parse(typed.timestamp as string) : Date.now(),
          },
          path,
        );
      } else if (outcome.outcome !== 'approved') {
        this.pendingPlans.delete(outcome.toolUseId);
      }
      return;
    }

    const docWrite = findDocWrite(typed);
    if (docWrite) {
      const captured = docToCapture(typed, docWrite, path);
      if (captured) this.capture(captured, path);
    }
  }

  private capture(doc: CapturedDoc, transcriptPath: string): void {
    if (!doc.entryUuid || this.seenEntries.has(doc.entryUuid)) return;
    this.seenEntries.add(doc.entryUuid);

    const result = this.repo.submit({
      project: doc.projectName,
      title: doc.title,
      body: doc.body,
      kind: doc.kind,
      source: 'watcher',
      agent: 'claude-code',
      sessionRef: transcriptPath,
      // Captured decisions are observations, not requests: the agent already
      // acted on them. Filing them as pending would fill the queue with
      // verdicts nobody is waiting for.
      initialStatus: 'approved',
    });

    if (!result.deduped) {
      this.bus.emitEvent({
        type: 'decision.added',
        decisionId: result.decision.id,
        projectName: doc.projectName,
        title: doc.title,
        status: result.decision.status,
        at: Date.now(),
      });
    }
  }
}
