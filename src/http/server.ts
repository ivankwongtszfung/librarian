import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { EventBus } from '../core/events.js';
import type { ReviewService } from '../core/review-service.js';
import type { DecisionStore } from '../domain/ports.js';
import { VerdictError } from '../domain/state-machine.js';
import type { DecisionKind, DecisionStatus } from '../domain/types.js';
import { createMcpServer } from '../mcp/server.js';

export interface HttpOptions {
  repo: DecisionStore;
  reviews: ReviewService;
  bus: EventBus;
  /** When set, every /api AND /mcp request must present it — as an
   *  `Authorization: Bearer` header or the `librarian_token` cookie. */
  token?: string;
  publicDir?: string;
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
