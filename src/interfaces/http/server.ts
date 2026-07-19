import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { ChannelRegistry } from '../../application/channel-registry.js';
import type { EventBus, LibrarianEvent } from '../../application/events.js';
import type { MessageService } from '../../application/message-service.js';
import type { ReviewService } from '../../application/review-service.js';
import type { DecisionStore } from '../../domain/ports.js';
import { VerdictError } from '../../domain/state-machine.js';
import type { DecisionKind, DecisionStatus } from '../../domain/types.js';
import {
  AttachmentError,
  resolveAttachment,
  saveDataUrl,
} from '../../infrastructure/service/attachments.js';
import {
  classifyDoc,
  projectNameFromFilePath,
  titleFromMarkdown,
} from '../../infrastructure/watcher/extract.js';
import { scanForDocs } from '../../infrastructure/watcher/scan.js';
import { createMcpServer } from '../mcp/server.js';

export interface HttpOptions {
  repo: DecisionStore;
  reviews: ReviewService;
  messages: MessageService;
  /** Which projects have a live channel session — routes messages (ADR-013). */
  channels: ChannelRegistry;
  bus: EventBus;
  /** When set, every /api AND /mcp request must present it — as an
   *  `Authorization: Bearer` header or the `librarian_token` cookie. */
  token?: string;
  publicDir?: string;
  /** The transcript dir being watched. When set, /api/projects also reports
   *  projects OBSERVED there that have no decisions yet — so the catchup can
   *  show what librarian is blind to, not just what it knows. */
  watchDir?: string;
  /** Where pasted screenshots are stored. The agent is handed the path. */
  attachmentsDir?: string;
}

export function createApp(opts: HttpOptions): express.Express {
  const { repo, reviews, bus } = opts;
  const app = express();
  app.use(express.json({ limit: '8mb' }));

  // ---------- auth ----------
  // The token authorizes a request regardless of which interface it arrived on,
  // so the SAME gate guards both /mcp and /api. A tunnel makes "localhost-only
  // by binding" false — cloudflared connects from loopback, so an ungated /mcp
  // would be world-readable the moment the daemon is exposed. The token is read
  // from the Authorization header or an HttpOnly cookie, never the query string,
  // which would leak into proxy logs, Referer headers, and notification URLs.
  const configuredDigest = opts.token ? sha256(opts.token) : null;
  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (!configuredDigest) {
      next(); // no token configured: loopback-only mode
      return;
    }
    const header = req.header('authorization') ?? '';
    const presented = header.startsWith('Bearer ')
      ? header.slice(7)
      : readCookie(req, 'librarian_token');
    // Constant-time: hash both sides to a fixed 32 bytes so neither the compare
    // nor the length leaks via timing.
    if (!presented || !timingSafeEqual(sha256(presented), configuredDigest)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    // Bootstrap the browser stream: once a caller proves the token via header,
    // hand back an HttpOnly cookie so EventSource — which cannot set headers —
    // can authenticate on later requests without the token ever touching a URL.
    if (header) {
      res.cookie('librarian_token', opts.token as string, {
        httpOnly: true,
        sameSite: 'strict',
        secure: req.secure || req.header('x-forwarded-proto') === 'https',
        path: '/',
      });
    }
    next();
  }

  // ---------- MCP ----------
  // Stateless: a fresh server + transport per request. All state lives in
  // SQLite, so there is nothing to keep in memory between calls — and a daemon
  // restart cannot strand a connected agent.
  app.post('/mcp', requireAuth, async (req: Request, res: Response) => {
    const server = createMcpServer(repo, reviews);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const methodNotAllowed = (_req: Request, res: Response) =>
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // Every /api surface — reads, writes, and the SSE stream — sits behind the
  // same gate defined above.
  app.use('/api', requireAuth);

  // ---------- reads ----------
  app.get('/api/decisions', (req: Request, res: Response) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const filters = {
      project: req.query.project as string | undefined,
      status: req.query.status as DecisionStatus | undefined,
      kind: req.query.kind as DecisionKind | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    };
    if (q) {
      res.json({ decisions: repo.search(q, filters), query: q });
      return;
    }
    res.json({ decisions: repo.listDecisions(filters) });
  });

  app.get('/api/decisions/:id', (req: Request, res: Response) => {
    const detail = repo.getDecisionDetail(req.params.id);
    if (!detail) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // The thread is the decision's rationale, so it has to render with authors,
    // not participant ids.
    const outcome = repo.reviewOutcome(req.params.id);
    res.json({ ...detail, thread: outcome?.comments ?? [] });
  });

  // REST twin of the MCP get_review tool, for non-agent clients (the wait CLI,
  // the Discord bridge). Holds server-side like the tool does; the hold is
  // released early if the client goes away, so an abandoned waiter never pins
  // the event bus.
  app.get('/api/decisions/:id/review', async (req: Request, res: Response) => {
    const raw = Number(req.query.wait_seconds);
    const waitSeconds = Number.isFinite(raw) && raw > 0 ? raw : 0;
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    try {
      const outcome = await reviews.getReview(req.params.id, waitSeconds, abort.signal);
      if (res.writableEnded || abort.signal.aborted) return;
      if ('error' in outcome) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json(outcome);
    } catch (err) {
      // An async throw here would otherwise become an unhandled rejection and
      // take the daemon down with it.
      if (!res.writableEnded && !abort.signal.aborted) {
        res.status(500).json({ error: 'internal', detail: String(err) });
      }
    }
  });

  app.get('/api/decisions/:id/diff', (req: Request, res: Response) => {
    const from = Number(req.query.from ?? 1);
    const to = Number(req.query.to ?? 2);
    const diff = reviews.diff(req.params.id, from, to);
    if (diff === null) {
      res.status(404).json({ error: 'version_not_found' });
      return;
    }
    res.json({ from, to, diff });
  });

  app.get('/api/projects', (_req: Request, res: Response) => {
    const projects = repo.listProjects();
    const observed = opts.watchDir
      ? observedProjects(opts.watchDir, new Set(projects.map((p) => p.name)))
      : [];
    res.json({ projects, observed });
  });

  // The rescan button (BUG-001, fix option 1): walk every known project root
  // for decision docs the watcher never saw, and import what's missing.
  // Deliberate, human-triggered, idempotent — content-hash dedup means a
  // rescan can never duplicate; imported records carry the file's mtime so
  // their dates tell the truth.
  app.post('/api/scan', (_req: Request, res: Response) => {
    const roots = new Map<string, string>();
    if (opts.watchDir) {
      for (const t of transcriptRoots(opts.watchDir)) roots.set(t.name, t.root);
    }
    for (const p of repo.listProjects()) {
      if (p.rootPath) roots.set(p.name, p.rootPath);
    }
    let files = 0;
    let known = 0;
    const imported: Array<{ project: string; title: string; kind: string }> = [];
    for (const [project, root] of roots) {
      for (const doc of scanForDocs(root)) {
        files++;
        const result = repo.submit({
          project: projectNameFromFilePath(doc.filePath) ?? project,
          title: titleFromMarkdown(doc.content, basename(doc.filePath, '.md')),
          body: doc.content,
          kind: classifyDoc(doc.filePath),
          source: 'mcp',
          initialStatus: 'approved',
          at: doc.modifiedAt,
        });
        if (result.deduped) known++;
        else
          imported.push({
            project: projectNameFromFilePath(doc.filePath) ?? project,
            title: result.decision.title,
            kind: result.decision.kind,
          });
      }
    }
    res.json({ ok: true, roots: roots.size, files, known, imported });
  });

  // The "Catch me up" button asks the agent to write the briefing: a canned
  // prompt is routed (ADR-013) to the project's own session, which generates it
  // and stores it via the record_catchup MCP tool. If no session for the
  // project is connected, the request parks (ADR-011) and runs when one shows.
  app.post('/api/projects/:name/catchup/request', (req: Request, res: Response) => {
    const project = req.params.name;
    const { queued } = opts.messages.post(catchupPrompt(project), {
      project,
      kind: 'catchup_request',
    });
    // A session for this project must be connected for the request to be acted
    // on now; otherwise it waits (and the pending surface shows it).
    const connected = opts.channels.hasProject(project);
    res.json({ ok: true, queued, connected });
  });

  // The stored catchup the agent generated (latest) + its version history.
  app.get('/api/projects/:name/catchup-doc', (req: Request, res: Response) => {
    const latest = repo.latestCatchup(req.params.name);
    const history = repo
      .catchupHistory(req.params.name)
      .map((c) => ({ id: c.id, createdAt: c.createdAt, generatedBy: c.generatedBy }));
    res.json({ latest, history });
  });

  // A deterministic auto-summary from the store — the instant fallback the UI
  // shows before (or instead of) an agent-written catchup.
  app.get('/api/projects/:name/catchup', (req: Request, res: Response) => {
    res.json(repo.projectCatchup(req.params.name));
  });

  app.get('/api/sessions/:id', (req: Request, res: Response) => {
    res.json({ sessionId: req.params.id, decisions: repo.getSessionDecisions(req.params.id) });
  });

  // ---------- writes ----------
  app.post('/api/decisions/:id/verdict', (req: Request, res: Response) => {
    const { to, reason, by } = req.body ?? {};
    if (to !== 'approved' && to !== 'rejected' && to !== 'changes_requested') {
      res.status(422).json({
        error: 'invalid_verdict',
        detail: 'to must be approved|rejected|changes_requested',
      });
      return;
    }
    try {
      reviews.postVerdict({ decisionId: req.params.id, to, reason, by });
      res.json({ ok: true, status: to });
    } catch (err) {
      if (err instanceof VerdictError) {
        // A red light without a reason is not a decision, it's a shrug.
        res.status(422).json({ error: err.code, detail: err.message });
        return;
      }
      res.status(404).json({ error: 'not_found' });
    }
  });

  app.post('/api/decisions/:id/comments', (req: Request, res: Response) => {
    const body = req.body ?? {};
    const raw = Array.isArray(body) ? body : Array.isArray(body.comments) ? body.comments : [body];
    const comments = raw
      .filter((c: unknown) => typeof (c as { body?: string }).body === 'string')
      .map((c: { body: string; anchor_quote?: string; version?: number }) => ({
        body: c.body,
        anchorQuote: c.anchor_quote ?? null,
        versionNum: c.version,
      }));

    if (comments.length === 0) {
      res.status(422).json({ error: 'no_comments' });
      return;
    }

    try {
      const result = reviews.postComments({
        decisionId: req.params.id,
        comments,
        by: body.by,
        requestChanges: body.request_changes === true,
        reason: body.reason,
      });
      res.json({ ok: true, added: result.added });
    } catch (err) {
      if (err instanceof VerdictError) {
        res.status(422).json({ error: err.code, detail: err.message });
        return;
      }
      res.status(404).json({ error: 'not_found' });
    }
  });

  // The page chat bar: the human speaks TO the agent from wherever they are
  // reading. The message is a live bus event relayed by the channel server as
  // an agent turn, with the page context attached automatically. When it was
  // typed on a decision page it is ALSO persisted as a thread comment, so the
  // rationale survives even if no agent is listening right now.
  app.post('/api/messages', (req: Request, res: Response) => {
    const { body, context } = req.body ?? {};
    if (typeof body !== 'string' || !body.trim()) {
      res.status(422).json({ error: 'empty_message' });
      return;
    }
    const ctx: Record<string, string> = {};
    if (context && typeof context === 'object') {
      for (const [k, v] of Object.entries(context as Record<string, unknown>)) {
        // A quoted passage is the point of the message, so it gets room; the
        // rest are labels and stay short.
        const cap = k === 'quote' ? 1200 : 300;
        if (typeof v === 'string' && v) ctx[k.slice(0, 40)] = v.slice(0, cap);
      }
    }
    let persisted = false;
    if (ctx.decisionId) {
      try {
        reviews.postComments({
          decisionId: ctx.decisionId,
          // A mouse selection becomes the comment's anchor, so the thread shows
          // the human's remark attached to the exact passage they highlighted.
          comments: [{ body: body.trim(), anchorQuote: ctx.quote ?? null }],
          authorType: 'human',
        });
        persisted = true;
      } catch {
        // Unknown decision: the durable message row still lands below.
      }
    }
    // Route by project (ADR-013): a message about a decision inherits that
    // decision's project; a message from a per-project page carries its own;
    // a bare "this page" message stays global. The decision's project is
    // authoritative — decision pages don't send it and it can't be spoofed.
    let project: string | null = null;
    if (ctx.decisionId) project = repo.getDecisionDetail(ctx.decisionId)?.projectName ?? null;
    if (!project && ctx.project) project = ctx.project;
    if (project) ctx.project = project; // decision's project is authoritative
    // Durable first, delivery scheduled by presence (ADR-011) and routing
    // (ADR-013): delivered when a matching session is listening and the agent
    // is free/unknown, queued while it works or until such a session connects.
    const { queued } = opts.messages.post(body.trim(), Object.keys(ctx).length ? ctx : null);
    res.json({ ok: true, queued, persisted, project });
  });

  // Claude Code hooks report the agent's turn state (ADR-011): working on
  // UserPromptSubmit, idle on Stop. Going idle flushes the queued backlog as
  // one batched channel turn. Best-effort: no hooks means presence unknown,
  // which behaves exactly like the pre-presence daemon.
  app.post('/api/presence', (req: Request, res: Response) => {
    const { state } = req.body ?? {};
    if (state !== 'working' && state !== 'idle') {
      res.status(422).json({ error: 'invalid_state', detail: 'state must be working|idle' });
      return;
    }
    opts.messages.reportPresence(state);
    res.json({ ok: true, working: opts.messages.agentIsWorking() });
  });

  // A screenshot pasted into the chat bar. Stored on disk beside the store; the
  // agent is handed the PATH and reads the file itself, because the channel
  // carries text only. Returns the browser URL for the preview thumbnail too.
  app.post('/api/attachments', (req: Request, res: Response) => {
    if (!opts.attachmentsDir) {
      res.status(503).json({ error: 'attachments_disabled' });
      return;
    }
    try {
      const saved = saveDataUrl(opts.attachmentsDir, req.body?.dataUrl);
      res.json({
        ok: true,
        file: saved.file,
        path: saved.path,
        bytes: saved.bytes,
        url: `/api/attachments/${saved.file}`,
      });
    } catch (err) {
      if (err instanceof AttachmentError) {
        res.status(422).json({ error: err.code });
        return;
      }
      res.status(500).json({ error: 'write_failed' });
    }
  });

  app.get('/api/attachments/:file', (req: Request, res: Response) => {
    const found = opts.attachmentsDir
      ? resolveAttachment(opts.attachmentsDir, req.params.file)
      : null;
    if (!found) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.type(found.mime).sendFile(found.path);
  });

  // Messages parked because no session for their project is connected yet
  // (ADR-013). The catchup surfaces this so a targeted question reads as
  // waiting-for-the-right-agent, not lost.
  app.get('/api/messages/pending', (_req: Request, res: Response) => {
    res.json({ waiting: opts.messages.pendingByProject() });
  });

  // ---------- SSE ----------
  app.get('/api/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Proxies buffer streamed responses by default; this asks them not to.
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    // Route by project (ADR-013): a channel session declares its project here;
    // the browser (EventSource can't set headers) declares none and sees all.
    const mine = req.header('x-librarian-project');
    const onEvent = (event: LibrarianEvent) => {
      // A session only ever receives its OWN project's messages, or global
      // (unprojected) ones. Non-message events stay unscoped (a verdict is read
      // by decision id; its path is a later decision).
      if (event.type === 'message' && event.projectName && mine && event.projectName !== mine) {
        return;
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    bus.on('event', onEvent);

    // A declared session joins the registry so parked messages know a home now
    // exists; connecting flushes anything waiting for its project (and, if it is
    // the first session up, any global backlog). The listener is registered
    // above first, so the synchronous flush reaches this very connection.
    if (mine) {
      opts.channels.add(mine);
      opts.messages.flush();
    }

    // Idle proxies drop silent sockets after 30–60s.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      bus.off('event', onEvent);
      if (mine) opts.channels.remove(mine);
    });
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'librarian' });
  });

  if (opts.publicDir) {
    // The catchup briefing is the home page: a context-switching reviewer
    // zooms out first, then drills into the library or a thread.
    app.get('/', (_req: Request, res: Response) => {
      res.sendFile('catchup.html', { root: opts.publicDir! });
    });
    app.use(express.static(opts.publicDir));
    app.get('/d/:id', (_req: Request, res: Response) => {
      res.sendFile('index.html', { root: opts.publicDir! });
    });
    // Per-project page: the library, scoped to one project.
    app.get('/p/:name', (_req: Request, res: Response) => {
      res.sendFile('index.html', { root: opts.publicDir! });
    });
  }

  return app;
}

/**
 * Projects visible in the transcript dir that the store doesn't know yet.
 * The true name comes from a transcript's own `cwd` field — the munged
 * directory name cannot distinguish `_` from `-` (lc_decision_tree and
 * lc-decision-tree share a directory name), so it is never trusted.
 */
/** Every project the transcript dir knows: true name AND root, from a
 *  transcript's own cwd (the munged dir name can't be trusted). */
function transcriptRoots(
  watchDir: string,
): Array<{ name: string; root: string; lastActivity: number }> {
  const out = new Map<string, { root: string; lastActivity: number }>();
  let entries: string[];
  try {
    entries = readdirSync(watchDir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const dir = join(watchDir, entry);
    let newest: { path: string; mtime: number } | null = null;
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = join(dir, f);
        const m = statSync(p).mtimeMs;
        if (!newest || m > newest.mtime) newest = { path: p, mtime: m };
      }
    } catch {
      continue;
    }
    if (!newest) continue;
    const cwd = transcriptCwd(newest.path);
    if (!cwd) continue;
    const name = basename(cwd);
    const prev = out.get(name);
    if (!prev || newest.mtime > prev.lastActivity) {
      out.set(name, { root: cwd, lastActivity: newest.mtime });
    }
  }
  return [...out.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.lastActivity - a.lastActivity);
}

function observedProjects(
  watchDir: string,
  known: Set<string>,
): Array<{ name: string; lastActivity: number }> {
  return transcriptRoots(watchDir)
    .filter((t) => !known.has(t.name))
    .map(({ name, lastActivity }) => ({ name, lastActivity }));
}

/** An early transcript line carries cwd — but not necessarily the first:
 *  compacted sessions open with summary lines. Scan what 64 KB holds. */
function transcriptCwd(transcriptPath: string): string | null {
  try {
    const fd = openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      try {
        const parsed = JSON.parse(line) as { cwd?: string };
        if (parsed.cwd) return parsed.cwd;
      } catch {
        // partial or non-JSON line — keep scanning
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** The instruction the "Catch me up" button sends to a project's agent. It is
 *  routed to that project's session (ADR-013); the agent grounds itself in the
 *  library, writes the briefing, and stores it with the record_catchup tool. */
function catchupPrompt(project: string): string {
  return [
    `[Catch me up] The human clicked "Catch me up" for project "${project}".`,
    '',
    `Write them a catchup briefing for "${project}" and store it by calling the`,
    'librarian tool record_catchup (project + body markdown). First ground it:',
    `call get_constraints and search_decisions for "${project}" so it reflects`,
    'reality, not memory.',
    '',
    'Follow the catchup standard: a RIGHT NOW single focus, a 🔴 critical block',
    '(blockers / risks / red lights), key decisions with their WHY, and recent',
    'activity. Scannable, facts over prose, no filler. This is data for the',
    'human — do not ask questions back, just generate and store it.',
  ].join('\n');
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

// The token never rides the query string, so it can only arrive by header or
// cookie. Parse the Cookie header by hand to avoid a parser dependency.
function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
