import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { EventBus } from '../core/events.js';
import type { ReviewService } from '../core/review-service.js';
import { VerdictError } from '../domain/state-machine.js';
import type { DecisionKind, DecisionStatus } from '../domain/types.js';
import { createMcpServer } from '../mcp/server.js';
import type { Repository } from '../store/repository.js';

export interface HttpOptions {
  repo: Repository;
  reviews: ReviewService;
  bus: EventBus;
  /** When set, every /api request must present it as a bearer token. */
  token?: string;
  publicDir?: string;
}

export function createApp(opts: HttpOptions): express.Express {
  const { repo, reviews, bus } = opts;
  const app = express();
  app.use(express.json({ limit: '8mb' }));

  // ---------- MCP ----------
  // Stateless: a fresh server + transport per request. All state lives in
  // SQLite, so there is nothing to keep in memory between calls — and a daemon
  // restart cannot strand a connected agent.
  app.post('/mcp', async (req: Request, res: Response) => {
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

  // ---------- auth (API only; MCP is localhost-only by binding) ----------
  // Transport-agnostic on purpose: the token is what authorizes a request, not
  // the interface it arrived on. That keeps LAN, Tailscale, and a future relay
  // interchangeable without touching this layer.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (!opts.token) return next();
    const header = req.header('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
    if (presented !== opts.token) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

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
    res.json({ projects: repo.listProjects() });
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

    const onEvent = (event: unknown) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    bus.on('event', onEvent);

    // Idle proxies drop silent sockets after 30–60s.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      bus.off('event', onEvent);
    });
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'librarian' });
  });

  if (opts.publicDir) {
    app.use(express.static(opts.publicDir));
    app.get('/d/:id', (_req: Request, res: Response) => {
      res.sendFile('index.html', { root: opts.publicDir! });
    });
  }

  return app;
}
